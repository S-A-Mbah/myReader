/**
 * Row → spoken script (FR-15 to FR-20). Pure and deterministic.
 */
import { LETTERS } from './mapping.js';

export const DEFAULT_TEMPLATE = 'Question {number}. {question}. Answer, {answer}.';
export const OPTIONS_TEMPLATE = 'Question {number}. {question}. {options}. Answer, {answer}.';
export const DEFAULT_MISSING_ANSWER = 'Answer not provided.';
export const PLACEHOLDERS = /** @type {const} */ ([
  'number',
  'question',
  'answer',
  'answerLetter',
  'answerText',
  'optionA',
  'optionB',
  'optionC',
  'optionD',
  'optionE',
  'options',
]);
const ANSWER_PLACEHOLDERS = new Set(['answer', 'answerLetter', 'answerText']);

/**
 * @typedef {'asWritten'|'optionText'|'letterAndText'} AnswerStyle
 * @typedef {Object} ScriptSettings
 * @property {string} [template]
 * @property {boolean} [readOptions]
 * @property {AnswerStyle} [answerStyle]
 * @property {string} [missingAnswerText]
 * @typedef {{text:string, parts:{question:string, answer:string}, skipped?: string}} RowScript
 */

/**
 * Normalise a cell for speech: blanks → "blank", whitespace collapsed (FR-19).
 * @param {unknown} v
 */
export function speakable(v) {
  return String(v ?? '')
    .replace(/\s*(?:_{2,}|…{2,}|\.{4,}|(?:\.\s){3,}\.?)\s*/g, ' blank ')
    .replace(/\s+/g, ' ')
    .replace(/ blank ([.,!?;:])/g, ' blank$1')
    .trim();
}

/**
 * "1." → "1", "1)" → "1", "Q3" → "3", "Question 4." → "4".
 * @param {string} v
 */
export function cleanNumber(v) {
  return speakable(v)
    .replace(/^(?:q(?:uestion)?|no|#)\.?\s*(?=\d)/i, '')
    .replace(/[.)\]:]+$/, '')
    .trim();
}

/**
 * Parse a combined options cell like "a) Berlin b) Paris" or "(A) Berlin (B) Paris".
 * Markers must appear in order A, B, C… so "Vitamin C. deficiency" is not split.
 * @param {string} cell
 * @returns {Partial<Record<'A'|'B'|'C'|'D'|'E', string>>}
 */
export function parseCombinedOptions(cell) {
  const s = String(cell ?? '');
  const re = /(?:^|\s)\(?([A-Ea-e])[).:]\s+/g;
  /** @type {{letter:string, markerStart:number, textStart:number}[]} */
  const marks = [];
  let expected = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const letter = m[1].toUpperCase();
    if (letter === LETTERS[expected]) {
      marks.push({ letter, markerStart: m.index, textStart: m.index + m[0].length });
      expected++;
    }
    // Allow the next marker's leading whitespace to be re-matched.
    re.lastIndex = m.index + m[0].length - 1;
  }
  /** @type {Partial<Record<'A'|'B'|'C'|'D'|'E', string>>} */
  const out = {};
  if (marks.length < 2) return out;
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].markerStart : s.length;
    out[/** @type {'A'} */ (mk.letter)] = speakable(s.slice(mk.textStart, end)).replace(/[;,]$/, '').trim();
  });
  return out;
}

/**
 * Collect the options for a row as {A: "...", B: "..."}.
 * @param {string[]} row
 * @param {import('./mapping.js').ColumnMapping} mapping
 */
export function getOptions(row, mapping) {
  const opts = mapping.options;
  if (Array.isArray(opts)) {
    /** @type {Partial<Record<'A'|'B'|'C'|'D'|'E', string>>} */
    const out = {};
    for (const { letter, col } of opts) {
      const v = speakable(row[col]);
      if (v) out[letter] = v;
    }
    return out;
  }
  if (opts && typeof opts.combinedCol === 'number') return parseCombinedOptions(row[opts.combinedCol] ?? '');
  return {};
}

/**
 * If the answer is a single letter A–E ("B", "(b)", "b)", "b.", "Option B"), return it upper-cased.
 * @param {string} answer
 * @returns {string|null}
 */
export function answerLetter(answer) {
  const s = speakable(answer).replace(/^(?:ans(?:wer)?|option|opt|choice)\s*[:.-]?\s*/i, '');
  const m = s.match(/^\(?([A-Ea-e])\)?[.):]?$/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Split a template into the question part and the answer part. The answer part
 * starts at the sentence containing the first answer placeholder, which is where
 * the pre-answer pause goes (FR-21).
 * @param {string} template
 * @returns {{question:string, answer:string}}
 */
export function splitTemplate(template) {
  const re = /\{(\w+)\}/g;
  let m;
  let at = -1;
  while ((m = re.exec(template)) !== null) {
    if (ANSWER_PLACEHOLDERS.has(m[1])) {
      at = m.index;
      break;
    }
  }
  if (at < 0) return { question: template, answer: '' };
  const before = template.slice(0, at);
  let cut = 0;
  const boundary = /[.?!:]\s+/g;
  while ((m = boundary.exec(before)) !== null) cut = m.index + m[0].length;
  return { question: template.slice(0, cut), answer: template.slice(cut) };
}

/**
 * Placeholder names in a template that are not supported.
 * @param {string} template
 */
export function unknownPlaceholders(template) {
  const out = [];
  for (const m of String(template).matchAll(/\{(\w+)\}/g)) {
    if (!(/** @type {readonly string[]} */ (PLACEHOLDERS).includes(m[1]))) out.push(m[1]);
  }
  return out;
}

/**
 * Fill placeholders. A value that already ends a sentence swallows a following
 * literal "." so "France?" + "." reads "France?" (FR-19); an empty value swallows it too.
 * @param {string} tpl
 * @param {Record<string,string>} values
 */
function render(tpl, values) {
  let out = '';
  let i = 0;
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(tpl)) !== null) {
    out += tpl.slice(i, m.index);
    const v = (values[m[1]] ?? '').trim();
    out += v;
    i = m.index + m[0].length;
    if (tpl[i] === '.' && (v === '' || /[.?!:…]$/.test(v))) i++;
    re.lastIndex = i;
  }
  out += tpl.slice(i);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/^[\s.,;:]+/, '')
    .replace(/([.,;:])(?:\s*[.,;:])+/g, '$1')
    .trim();
}

/**
 * Build the spoken script for one data row.
 * @param {string[]} row
 * @param {import('./mapping.js').ColumnMapping} mapping
 * @param {ScriptSettings} [settings]
 * @param {number} [position] 1-based data-row position, used when there is no number column (FR-14)
 * @returns {RowScript}
 */
export function buildRowScript(row, mapping, settings = {}, position = 1) {
  const template = settings.template?.trim() || DEFAULT_TEMPLATE;
  const style = settings.answerStyle ?? 'letterAndText';
  const missing = settings.missingAnswerText?.trim() || DEFAULT_MISSING_ANSWER;

  const question = mapping.question !== null ? speakable(row[mapping.question]) : '';
  if (!question) return { text: '', parts: { question: '', answer: '' }, skipped: 'No question' };

  const numCell = mapping.number !== null ? cleanNumber(row[mapping.number] ?? '') : '';
  const number = numCell || String(position);
  const options = getOptions(row, mapping);
  const rawAnswer = mapping.answer !== null ? speakable(row[mapping.answer]) : '';

  const letter = answerLetter(rawAnswer);
  const letterText = letter ? options[/** @type {'A'} */ (letter)] : undefined;
  let answer = rawAnswer;
  let answerLetterValue = '';
  let answerTextValue = rawAnswer;
  if (letter) {
    answerLetterValue = letter;
    if (letterText) {
      answerTextValue = letterText;
      answer = style === 'optionText' ? letterText : style === 'letterAndText' ? `${letter}, ${letterText}` : letter;
    } else {
      answer = letter;
      answerTextValue = letter;
    }
  } else if (rawAnswer) {
    const match = Object.entries(options).find(([, t]) => t && t.toLowerCase() === rawAnswer.toLowerCase());
    if (match) answerLetterValue = match[0];
  }

  const optionsSpoken = LETTERS.filter((l) => options[l])
    .map((l) => `${l}, ${String(options[l]).replace(/\.+$/, '')}`)
    .join('. ');

  /** @type {Record<string,string>} */
  const values = {
    number,
    question,
    answer,
    answerLetter: answerLetterValue,
    answerText: answerTextValue,
    options: optionsSpoken,
  };
  for (const l of LETTERS) values[`option${l}`] = options[l] ?? '';

  const { question: baseQ, answer: aTpl } = splitTemplate(template);
  let qTpl = baseQ;
  if (settings.readOptions && !template.includes('{options}')) qTpl = `${qTpl.trimEnd()} {options}. `;

  const qText = render(qTpl, values);
  const aText = rawAnswer ? render(aTpl, values) : aTpl.trim() ? missing : '';
  const text = [qText, aText].filter(Boolean).join(' ');
  return { text, parts: { question: qText, answer: aText } };
}
