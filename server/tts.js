/**
 * Kokoro TTS engine: one model instance, a serial two-priority job queue, and an
 * LRU cache of generated PCM. All Kokoro specifics stay in this file behind
 * init() / listVoices() / synthesize() (PRD §13), so a different backend can
 * replace it later without touching routes.
 */
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { chunkText } from '../src/shared/chunker.js';

export const SAMPLE_RATE = 24000;
/** Kokoro truncates input past ~510 phoneme tokens; 400 chars per call keeps us well under. */
const MAX_CALL_CHARS = 400;

/** @typedef {'high'|'normal'|'low'} Priority */
const RANK = { high: 0, normal: 1, low: 2 };

/**
 * @typedef {'idle'|'loading'|'ready'|'error'} EngineState
 * @typedef {{id:string, name:string, language:string, gender:string, grade:string}} VoiceInfo
 */

class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

/** Least-recently-used cache bounded by entry count and total bytes. */
class LruCache {
  /** @param {number} maxEntries @param {number} maxBytes */
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    /** @type {Map<string, Float32Array>} */
    this.map = new Map();
  }
  /** @param {string} key */
  get(key) {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  /** @param {string} key @param {Float32Array} value */
  set(key, value) {
    if (this.map.has(key)) {
      this.bytes -= /** @type {Float32Array} */ (this.map.get(key)).byteLength;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.byteLength;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= /** @type {Float32Array} */ (this.map.get(oldest)).byteLength;
      this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

/**
 * @typedef {Object} Job
 * @property {string} key
 * @property {() => Promise<Float32Array>} run
 * @property {Promise<Float32Array>} promise
 * @property {(v: Float32Array) => void} resolve
 * @property {(e: unknown) => void} reject
 * @property {number} waiters
 * @property {boolean} started
 * @property {Priority} priority
 */

export class TtsEngine {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    this.config = config;
    /** @type {EngineState} */
    this.state = 'idle';
    /** @type {string|null} */
    this.error = null;
    /** @type {{file:string, progress:number}|null} */
    this.progress = null;
    /** @type {KokoroTTS|null} */
    this.tts = null;
    /** Queues by priority: current playback, then prefetch, then export work. */
    /** @type {Record<Priority, Job[]>} */
    this.queues = { high: [], normal: [], low: [] };
    /** @type {Map<string, Job>} */
    this.pending = new Map();
    this.busy = false;
    // ~200 segments (FR-38) and at most ~200 MB of float PCM (≈35 minutes of audio).
    this.cache = new LruCache(300, 200 * 1024 * 1024);
  }

  /**
   * Load the model once. Tries the local cache with remote downloads disabled first,
   * so a cached model never touches the network; downloads only when that fails.
   * Retries with backoff; leaves state 'error' with a readable message on failure.
   */
  async init() {
    if (this.state === 'loading' || this.state === 'ready') return;
    this.state = 'loading';
    this.error = null;
    // Downloads land in cacheDir using the hub layout (<cacheDir>/<org>/<model>/...).
    // Pointing localModelPath at the same folder lets the offline attempt read them
    // back; transformers.js refuses to run with both local and remote disabled.
    env.cacheDir = this.config.cacheDir;
    env.localModelPath = this.config.cacheDir;
    env.allowLocalModels = true;

    const load = (/** @type {boolean} */ remote) => {
      env.allowRemoteModels = remote;
      return KokoroTTS.from_pretrained(this.config.model, {
        dtype: this.config.dtype,
        device: 'cpu',
        progress_callback: (p) => {
          if (p.status === 'progress') this.progress = { file: p.file, progress: Math.round(p.progress) };
        },
      });
    };

    const delays = [0, 3000, 10000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
      try {
        try {
          this.tts = await load(false);
          console.log('[tts] Loaded model from local cache (offline).');
        } catch {
          console.log(
            '[tts] Model not cached yet. Downloading (first run only: about 330 MB for fp32, 90 MB for q8)...',
          );
          this.tts = await load(true);
        }
        env.allowRemoteModels = false;
        // Warm-up so the first real request is not paying session start-up cost.
        await this.tts.generate('Ready.', { voice: this.defaultVoice(), speed: 1 });
        this.state = 'ready';
        this.progress = null;
        console.log(`[tts] Model ready (${this.config.model}, ${this.config.dtype}).`);
        return;
      } catch (err) {
        const msg = /** @type {Error} */ (err)?.message ?? String(err);
        console.error(`[tts] Load attempt ${attempt + 1} failed: ${msg}`);
        this.error = /fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|getaddrinfo/i.test(msg)
          ? 'Could not download the voice model. Check your internet connection for the first run, then retry.'
          : `Could not load the voice model: ${msg}`;
      }
    }
    this.state = 'error';
  }

  /** Voice id used when none (or an unknown one) is requested. */
  defaultVoice() {
    const ids = Object.keys(this.voicesTable());
    return ids.includes(this.config.defaultVoice) ? this.config.defaultVoice : ids[0];
  }

  /** @returns {Record<string, {name:string, language:string, gender:string, overallGrade?:string}>} */
  voicesTable() {
    // `voices` is a static table in kokoro-js; reachable through the prototype before load.
    return this.tts
      ? this.tts.voices
      : (Object.getOwnPropertyDescriptor(KokoroTTS.prototype, 'voices')?.get?.call({}) ?? {});
  }

  /** @returns {VoiceInfo[]} */
  listVoices() {
    return Object.entries(this.voicesTable()).map(([id, v]) => ({
      id,
      name: v.name,
      language: v.language,
      gender: v.gender,
      grade: v.overallGrade ?? '',
    }));
  }

  /** @param {unknown} id */
  hasVoice(id) {
    return typeof id === 'string' && Object.hasOwn(this.voicesTable(), id);
  }

  /**
   * Generate speech PCM (Float32, 24 kHz mono) for text. Cached; deduplicated with
   * any identical queued request; abortable while still queued.
   * @param {string} text
   * @param {string} voice
   * @param {number} speed
   * @param {{priority?: Priority, signal?: AbortSignal}} [opts]
   * @returns {Promise<Float32Array>}
   */
  synthesize(text, voice, speed, opts = {}) {
    if (this.state !== 'ready' || !this.tts) return Promise.reject(new Error('Model not ready'));
    const key = `${voice}\u0000${speed}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);

    const priority = opts.priority ?? 'high';
    let job = this.pending.get(key);
    if (job) {
      job.waiters++;
      // A more urgent request for audio that is already queued moves the job up.
      if (!job.started && RANK[priority] < RANK[job.priority]) {
        const j = job;
        this.queues[j.priority] = this.queues[j.priority].filter((x) => x !== j);
        j.priority = priority;
        this.queues[priority].push(j);
      }
    } else {
      /** @type {(v: Float32Array) => void} */
      let resolve = () => {};
      /** @type {(e: unknown) => void} */
      let reject = () => {};
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      job = {
        key,
        run: () => this.#generate(text, voice, speed),
        promise,
        resolve,
        reject,
        waiters: 1,
        started: false,
        priority,
      };
      this.pending.set(key, job);
      this.queues[priority].push(job);
      queueMicrotask(() => this.#pump());
    }

    const j = job;
    const signal = opts.signal;
    if (!signal) return j.promise;
    if (signal.aborted) {
      this.#release(j);
      return Promise.reject(new AbortError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#release(j);
        reject(new AbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      j.promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** Drop one waiter; a queued job nobody waits for is removed before it runs. @param {Job} job */
  #release(job) {
    job.waiters--;
    if (job.waiters <= 0 && !job.started) {
      this.queues[job.priority] = this.queues[job.priority].filter((j) => j !== job);
      this.pending.delete(job.key);
      job.reject(new AbortError());
      job.promise.catch(() => {}); // nobody is listening any more
    }
  }

  /** Run queued jobs one at a time (concurrency 1 keeps memory flat, PRD §7). */
  async #pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const job = this.queues.high.shift() ?? this.queues.normal.shift() ?? this.queues.low.shift();
        if (!job) break;
        job.started = true;
        try {
          const pcm = await job.run();
          this.cache.set(job.key, pcm);
          job.resolve(pcm);
        } catch (err) {
          job.reject(err);
        } finally {
          this.pending.delete(job.key);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * @param {string} text
   * @param {string} voice
   * @param {number} speed
   */
  async #generate(text, voice, speed) {
    const tts = /** @type {KokoroTTS} */ (this.tts);
    const pieces =
      text.length > MAX_CALL_CHARS ? chunkText(text, { maxChars: MAX_CALL_CHARS }).map((c) => c.text) : [text];
    /** @type {Float32Array[]} */
    const parts = [];
    for (const piece of pieces) {
      // Text with no letters or digits produces no speech (and can trip the phonemizer).
      if (!/[\p{L}\p{N}]/u.test(piece)) continue;
      const audio = await tts.generate(piece, { voice: /** @type {any} */ (voice), speed });
      parts.push(audio.audio);
    }
    if (parts.length === 1) return parts[0];
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  /** Jobs waiting (for health/diagnostics). */
  queueDepth() {
    const q = this.queues;
    return q.high.length + q.normal.length + q.low.length + (this.busy ? 1 : 0);
  }
}

export { AbortError };
