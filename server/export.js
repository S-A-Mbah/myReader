/**
 * Export jobs (FR-40 to FR-44): generate every segment through the shared TTS
 * queue at low priority, insert pauses as silence, stream to a temp file, and
 * report progress to subscribers (Server-Sent Events).
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SAMPLE_RATE } from './tts.js';
import {
  createWavWriter,
  createMp3Writer,
  createZipWriter,
  floatToInt16,
  silenceSamples,
  srtTime,
  MP3_AVAILABLE,
} from './audio.js';

const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS_KEPT = 5;

/**
 * @typedef {{text:string, pauseAfterMs:number, group:number}} ExportSegment
 * @typedef {'wav'|'mp3'|'zip'} ExportFormat
 * @typedef {Object} ExportJob
 * @property {string} id
 * @property {'running'|'done'|'error'|'cancelled'} status
 * @property {number} done         groups (rows / sentences) finished
 * @property {number} total        groups in the export
 * @property {string|null} error
 * @property {ExportFormat} format
 * @property {string} filePath
 * @property {string} transcript   SRT text, ready once done
 * @property {number} durationSec
 * @property {number} finishedAt
 * @property {AbortController} controller
 * @property {Set<(job: ExportJob) => void>} listeners
 */

const CONTENT_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', zip: 'application/zip' };

export class ExportManager {
  /** @param {import('./tts.js').TtsEngine} engine */
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, ExportJob>} */
    this.jobs = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** @returns {ExportFormat[]} */
  formats() {
    return MP3_AVAILABLE ? ['wav', 'mp3', 'zip'] : ['wav', 'zip'];
  }

  running() {
    return [...this.jobs.values()].some((j) => j.status === 'running');
  }

  /** @param {string} id */
  get(id) {
    return this.jobs.get(id);
  }

  /**
   * Public, serialisable view of a job.
   * @param {ExportJob} job
   */
  view(job) {
    return {
      id: job.id,
      status: job.status,
      done: job.done,
      total: job.total,
      error: job.error,
      format: job.format,
      durationSec: Math.round(job.durationSec),
    };
  }

  /** @param {ExportJob} job */
  contentType(job) {
    return CONTENT_TYPES[job.format];
  }

  /**
   * Start an export. Inputs are already validated by the route.
   * @param {{segments: ExportSegment[], voice: string, speed: number, format: ExportFormat, prefix: string}} req
   * @returns {ExportJob}
   */
  create(req) {
    const id = randomUUID();
    // The temp path is built from a server-generated UUID only, never from user input.
    const filePath = path.join(os.tmpdir(), `readaloud-${id}.${req.format}`);
    const groups = new Set(req.segments.map((s) => s.group));
    /** @type {ExportJob} */
    const job = {
      id,
      status: 'running',
      done: 0,
      total: groups.size,
      error: null,
      format: req.format,
      filePath,
      transcript: '',
      durationSec: 0,
      finishedAt: 0,
      controller: new AbortController(),
      listeners: new Set(),
    };
    this.jobs.set(id, job);
    this.#run(job, req).catch((err) => {
      if (job.status === 'running') {
        job.status = 'error';
        job.error = 'Export failed. Please try again.';
        console.error('[export] failed:', /** @type {Error} */ (err)?.message ?? err);
      }
      job.finishedAt = Date.now();
      rm(job.filePath, { force: true }).catch(() => {});
      this.#emit(job);
    });
    this.#trim();
    return job;
  }

  /** @param {ExportJob} job */
  cancel(job) {
    if (job.status !== 'running') return;
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.controller.abort();
    this.#emit(job);
  }

  /**
   * @param {ExportJob} job
   * @param {(job: ExportJob) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(job, fn) {
    job.listeners.add(fn);
    return () => job.listeners.delete(fn);
  }

  /** @param {ExportJob} job */
  #emit(job) {
    for (const fn of job.listeners) {
      try {
        fn(job);
      } catch {
        /* a broken listener must not break the job */
      }
    }
  }

  /**
   * @param {ExportJob} job
   * @param {{segments: ExportSegment[], voice: string, speed: number, format: ExportFormat, prefix: string}} req
   */
  async #run(job, req) {
    const { signal } = job.controller;
    const writer =
      req.format === 'mp3'
        ? await createMp3Writer(job.filePath, SAMPLE_RATE)
        : req.format === 'zip'
          ? await createZipWriter(job.filePath, SAMPLE_RATE, req.prefix)
          : await createWavWriter(job.filePath, SAMPLE_RATE);

    /** @type {string[]} */
    const srt = [];
    let cursorSamples = 0; // position in the single-file output
    let groupCursor = 0; // position inside the current zip entry
    let groupIndex = 0;
    try {
      for (let i = 0; i < req.segments.length; i++) {
        if (signal.aborted) throw new Error('cancelled');
        const seg = req.segments[i];
        const pcm = seg.text.trim()
          ? await this.engine.synthesize(seg.text, req.voice, req.speed, { priority: 'low', signal })
          : new Float32Array(0);
        const speech = floatToInt16(pcm);
        const pause = new Int16Array(silenceSamples(seg.pauseAfterMs, SAMPLE_RATE));
        const base = req.format === 'zip' ? groupCursor : cursorSamples;
        if (speech.length) {
          srt.push(
            `${srt.length + 1}\n${srtTime(base / SAMPLE_RATE)} --> ${srtTime((base + speech.length) / SAMPLE_RATE)}\n${seg.text}\n`,
          );
        }
        await writer.write(speech);
        const lastOfGroup = i + 1 === req.segments.length || req.segments[i + 1].group !== seg.group;
        // In a per-row zip the pause after the last segment would only pad the file.
        if (!(req.format === 'zip' && lastOfGroup)) await writer.write(pause);
        cursorSamples += speech.length + pause.length;
        groupCursor += speech.length + pause.length;
        if (lastOfGroup) {
          if (writer.endGroup) await writer.endGroup(groupIndex);
          groupIndex++;
          groupCursor = 0;
          job.done++;
          job.durationSec = cursorSamples / SAMPLE_RATE;
          this.#emit(job);
        }
      }
      await writer.finish();
    } catch (err) {
      await writer.abort();
      await rm(job.filePath, { force: true }).catch(() => {});
      if (job.status === 'cancelled') return;
      throw err;
    }
    if (job.status !== 'running') {
      await rm(job.filePath, { force: true }).catch(() => {});
      return;
    }
    job.transcript = srt.join('\n');
    job.status = 'done';
    job.finishedAt = Date.now();
    this.#emit(job);
  }

  /** Keep only the newest few finished jobs. */
  #trim() {
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (this.jobs.size > MAX_JOBS_KEPT && finished.length) this.#drop(/** @type {ExportJob} */ (finished.shift()));
  }

  /** @param {ExportJob} job */
  #drop(job) {
    this.jobs.delete(job.id);
    rm(job.filePath, { force: true }).catch(() => {});
  }

  /** Delete expired job files. */
  sweep() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' && now - job.finishedAt > JOB_TTL_MS) this.#drop(job);
    }
  }

  /** Cancel everything and remove temp files (shutdown). */
  async dispose() {
    clearInterval(this.sweeper);
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller.abort();
      await rm(job.filePath, { force: true }).catch(() => {});
    }
    this.jobs.clear();
  }
}
