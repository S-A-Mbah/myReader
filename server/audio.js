/**
 * PCM helpers and file writers: 16-bit WAV, MP3 (lamejs, optional) and per-row ZIP.
 * Writers stream to disk so a long export never holds the whole file in memory.
 */
import { open } from 'node:fs/promises';
import { Zip, ZipPassThrough } from 'fflate';

/** @type {typeof import('@breezystack/lamejs') | null} */
let lame = null;
try {
  lame = await import('@breezystack/lamejs');
} catch {
  lame = null; // MP3 export is optional (FR-41): hide it when the encoder is missing.
}
export const MP3_AVAILABLE = lame !== null;

const WAV_MAX_DATA_BYTES = 0xffffffff - 36;

/**
 * Float32 [-1, 1] → Int16 PCM with clipping.
 * @param {Float32Array} f32
 */
export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Number of samples for a pause.
 * @param {number} ms
 * @param {number} sampleRate
 */
export function silenceSamples(ms, sampleRate) {
  return Math.max(0, Math.round((ms / 1000) * sampleRate));
}

/**
 * 44-byte RIFF header for mono 16-bit PCM.
 * @param {number} dataBytes
 * @param {number} sampleRate
 */
export function wavHeader(dataBytes, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * A complete in-memory WAV: speech followed by `pauseAfterMs` of silence.
 * Used for playback segments; trailing silence lets the browser time the
 * between-row pause with the audio clock, which keeps working in background tabs
 * where timers are throttled.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {number} [pauseAfterMs]
 */
export function encodeWav(pcm, sampleRate, pauseAfterMs = 0) {
  const speech = floatToInt16(pcm);
  const total = speech.length + silenceSamples(pauseAfterMs, sampleRate);
  const buf = Buffer.alloc(44 + total * 2);
  wavHeader(total * 2, sampleRate).copy(buf, 0);
  Buffer.from(speech.buffer, speech.byteOffset, speech.byteLength).copy(buf, 44);
  return buf; // the silence tail is already zero-filled
}

/** Yield to the event loop so long encodes don't stall other requests. */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Streaming writer interface used by export jobs.
 * @typedef {Object} AudioWriter
 * @property {(samples: Int16Array) => Promise<void>} write   append PCM to the current file
 * @property {(index: number) => Promise<void>} [endGroup]     finish one row's file (zip only)
 * @property {() => Promise<void>} finish
 * @property {() => Promise<void>} abort
 */

/**
 * Single WAV file on disk; the header is patched with the real size at the end.
 * @param {string} filePath
 * @param {number} sampleRate
 * @returns {Promise<AudioWriter>}
 */
export async function createWavWriter(filePath, sampleRate) {
  const fh = await open(filePath, 'w');
  await fh.write(wavHeader(0, sampleRate), 0, 44, 0);
  let bytes = 0;
  return {
    async write(samples) {
      if (bytes + samples.byteLength > WAV_MAX_DATA_BYTES) throw new Error('Export is too long for a single WAV file.');
      await fh.write(
        Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
        0,
        samples.byteLength,
        44 + bytes,
      );
      bytes += samples.byteLength;
    },
    async finish() {
      await fh.write(wavHeader(bytes, sampleRate), 0, 44, 0);
      await fh.close();
    },
    async abort() {
      await fh.close().catch(() => {});
    },
  };
}

/**
 * Single MP3 file (96 kbps mono, plenty for speech).
 * @param {string} filePath
 * @param {number} sampleRate
 * @returns {Promise<AudioWriter>}
 */
export async function createMp3Writer(filePath, sampleRate) {
  if (!lame) throw new Error('MP3 encoding is not available.');
  const encoder = new lame.Mp3Encoder(1, sampleRate, 96);
  const fh = await open(filePath, 'w');
  const BLOCK = 1152 * 20;
  return {
    async write(samples) {
      for (let i = 0; i < samples.length; i += BLOCK) {
        const mp3 = encoder.encodeBuffer(samples.subarray(i, i + BLOCK));
        if (mp3.length) await fh.write(mp3);
        if ((i / BLOCK) % 10 === 9) await tick();
      }
    },
    async finish() {
      const tail = encoder.flush();
      if (tail.length) await fh.write(tail);
      await fh.close();
    },
    async abort() {
      await fh.close().catch(() => {});
    },
  };
}

/**
 * ZIP of one WAV per group: Q001.wav, Q002.wav, ... (FR-43). Entries are stored,
 * not deflated: PCM barely compresses and storing keeps the export fast.
 * @param {string} filePath
 * @param {number} sampleRate
 * @param {string} prefix file name prefix, already validated as letters only
 * @returns {Promise<AudioWriter>}
 */
export async function createZipWriter(filePath, sampleRate, prefix) {
  const fh = await open(filePath, 'w');
  /** @type {Promise<unknown>} */
  let writing = Promise.resolve();
  /** @type {Error|null} */
  let failed = null;
  /** @type {() => void} */
  let onFinal = () => {};
  const finished = new Promise((r) => (onFinal = /** @type {() => void} */ (r)));
  const zip = new Zip((err, chunk, final) => {
    if (err) failed = err;
    else writing = writing.then(() => fh.write(chunk));
    if (final) onFinal();
  });
  /** @type {Int16Array[]} */
  let current = [];
  return {
    async write(samples) {
      current.push(samples.slice());
    },
    async endGroup(index) {
      const total = current.reduce((n, s) => n + s.byteLength, 0);
      const wav = new Uint8Array(44 + total);
      wav.set(wavHeader(total, sampleRate), 0);
      let off = 44;
      for (const s of current) {
        wav.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), off);
        off += s.byteLength;
      }
      current = [];
      const entry = new ZipPassThrough(`${prefix}${String(index + 1).padStart(3, '0')}.wav`);
      zip.add(entry);
      entry.push(wav, true);
      await writing;
      if (failed) throw failed;
    },
    async finish() {
      zip.end();
      await finished;
      await writing;
      if (failed) throw failed;
      await fh.close();
    },
    async abort() {
      try {
        zip.terminate();
      } catch {
        /* already ended */
      }
      await writing.catch(() => {});
      await fh.close().catch(() => {});
    },
  };
}

/**
 * Format seconds as an SRT timestamp: 00:01:02,345
 * @param {number} sec
 */
export function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}
