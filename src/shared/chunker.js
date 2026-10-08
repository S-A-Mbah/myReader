/**
 * Plain text → sentence chunks. Pure module, shared by the browser and Node.
 *
 * Each chunk keeps its character offsets into the original text so the UI can
 * highlight exactly what is being spoken (FR-9), and records whether a blank
 * line (paragraph break) follows it so the player can add a longer pause (FR-10).
 */

/** Default max characters per chunk (FR-8). Kokoro truncates at ~510 phoneme tokens. */
export const MAX_CHUNK_CHARS = 400;

// Lower-cased abbreviations that end with "." but do not end a sentence.
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'no',
  'fig',
  'figs',
  'eq',
  'approx',
  'dept',
  'est',
  'gen',
  'gov',
  'lt',
  'col',
  'capt',
  'sgt',
  'rev',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'e.g',
  'i.e',
  'cf',
  'al',
  'vol',
  'p',
  'pp',
  'ed',
  'ch',
  'sec',
]);

/**
 * @typedef {Object} TextChunk
 * @property {string} text   Chunk text, whitespace-collapsed, ready for TTS.
 * @property {number} start  Start offset in the source string (inclusive).
 * @property {number} end    End offset in the source string (exclusive).
 * @property {boolean} paragraphEnd  True when a blank line follows this chunk.
 */

/**
 * Is the "." at index i a real sentence terminator?
 * @param {string} text
 * @param {number} i
 */
function isSentenceDot(text, i) {
  const prev = text[i - 1] ?? '';
  const next = text[i + 1] ?? '';
  // Decimal number: 3.14
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  // Ellipsis or run of dots: only the last one terminates.
  if (next === '.') return false;
  // Token before the dot, e.g. "Dr" or "e.g" or "U.S".
  let s = i - 1;
  while (s >= 0 && /[A-Za-z.]/.test(text[s])) s--;
  const word = text.slice(s + 1, i).toLowerCase();
  if (ABBREVIATIONS.has(word)) return false;
  // Initials ("J. Smith") and dotted acronyms ("U.S. Army") rarely end a sentence;
  // merging two sentences is harmless, splitting a name mid-way sounds wrong.
  if (/^([a-z]\.)*[a-z]$/.test(word) && /^[A-Z]/.test(text.slice(i + 1).trimStart())) {
    if (word.length === 1 && /[A-Z]/.test(text[i - 1])) return false;
    if (word.includes('.')) return false;
  }
  // Lower-case continuation ("approx. five") is not a new sentence.
  const after = text.slice(i + 1).match(/^\s*(\S)/);
  if (after && /[a-z]/.test(after[1]) && /\s/.test(next)) return false;
  return true;
}

/**
 * Split an oversized sentence on the best available boundary (clause punctuation,
 * then whitespace) so no piece exceeds maxChars.
 * @param {string} text
 * @param {number} offset
 * @param {number} maxChars
 * @returns {{start:number,end:number}[]}
 */
function splitLong(text, offset, maxChars) {
  const out = [];
  let start = 0;
  while (text.length - start > maxChars) {
    const window = text.slice(start, start + maxChars);
    let cut = -1;
    for (const re of [/[;:,)\]—–-]\s/g, /\s/g]) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(window)) !== null) {
        // Avoid tiny leading fragments: only cut in the back half.
        if (m.index > maxChars * 0.4) cut = m.index + 1;
      }
      if (cut > 0) break;
    }
    if (cut <= 0) cut = maxChars; // one giant token: hard cut
    out.push({ start: offset + start, end: offset + start + cut });
    start += cut;
    while (start < text.length && /\s/.test(text[start])) start++;
  }
  if (start < text.length) out.push({ start: offset + start, end: offset + text.length });
  return out;
}

/**
 * Split plain text into sentence-sized chunks with source offsets.
 * @param {string} text
 * @param {{maxChars?: number}} [opts]
 * @returns {TextChunk[]}
 */
export function chunkText(text, opts = {}) {
  const maxChars = opts.maxChars ?? MAX_CHUNK_CHARS;
  if (typeof text !== 'string' || !text.trim()) return [];
  const src = text.replace(/\r\n?/g, '\n');

  /** @type {{start:number,end:number}[]} */
  const sentences = [];
  let start = 0;
  const push = (end) => {
    // Trim the span to its non-whitespace content.
    let s = start;
    let e = end;
    while (s < e && /\s/.test(src[s])) s++;
    while (e > s && /\s/.test(src[e - 1])) e--;
    if (e > s && /[\p{L}\p{N}]/u.test(src.slice(s, e))) sentences.push({ start: s, end: e });
    start = end;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') {
      push(i);
      continue;
    }
    if (ch === '!' || ch === '?' || ch === '…' || (ch === '.' && isSentenceDot(src, i))) {
      // Absorb trailing closing quotes / brackets and repeated terminators.
      let j = i + 1;
      while (j < src.length && /[.!?…"'”’)\]]/.test(src[j])) j++;
      if (j >= src.length || /\s/.test(src[j])) {
        push(j);
        i = j - 1;
      }
    }
  }
  push(src.length);

  /** @type {TextChunk[]} */
  const chunks = [];
  for (const s of sentences) {
    const raw = src.slice(s.start, s.end);
    const pieces = raw.length > maxChars ? splitLong(raw, s.start, maxChars) : [s];
    for (const p of pieces) {
      chunks.push({
        text: src.slice(p.start, p.end).replace(/\s+/g, ' ').trim(),
        start: p.start,
        end: p.end,
        paragraphEnd: false,
      });
    }
  }
  // A chunk ends a paragraph when only whitespace containing a blank line follows it.
  for (let k = 0; k < chunks.length; k++) {
    const nextStart = k + 1 < chunks.length ? chunks[k + 1].start : src.length;
    const gap = src.slice(chunks[k].end, nextStart);
    chunks[k].paragraphEnd = /\n[^\S\n]*\n/.test(gap);
  }
  return chunks;
}
