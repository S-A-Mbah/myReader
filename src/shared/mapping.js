/**
 * Header → role auto-mapping (FR-12). Pure module.
 */

/**
 * @typedef {'A'|'B'|'C'|'D'|'E'} OptionLetter
 * @typedef {{letter: OptionLetter, col: number}[] | {combinedCol: number}} OptionsMapping
 * @typedef {Object} ColumnMapping
 * @property {number|null} number
 * @property {number|null} question
 * @property {number|null} answer
 * @property {OptionsMapping} options
 */

export const LETTERS = /** @type {const} */ (['A', 'B', 'C', 'D', 'E']);

/**
 * Normalise a header for matching: lower-case, punctuation (except # and /) to
 * spaces, collapsed whitespace. "Q. No." → "q no", "(a)" → "a".
 * @param {string} h
 */
export function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER_EXACT = new Set([
  'no',
  'number',
  'num',
  'nr',
  '#',
  'q#',
  'q #',
  'q no',
  'qno',
  'q num',
  'q number',
  'question no',
  'question number',
  'question num',
  'question #',
  'ques no',
  'qn',
  'qn no',
  's/n',
  'sn',
  's n',
  'sl no',
  'sr no',
  's no',
  'serial',
  'serial no',
  'serial number',
  'id',
  'item',
  'item no',
  'n',
]);
const QUESTION_EXACT = new Set([
  'question',
  'questions',
  'q',
  'ques',
  'qn text',
  'stem',
  'prompt',
  'question text',
  'item text',
]);
const ANSWER_EXACT = new Set([
  'answer',
  'answers',
  'ans',
  'correct',
  'correct answer',
  'correct option',
  'correct ans',
  'key',
  'answer key',
  'solution',
  'right answer',
  'ans key',
  'correct choice',
]);
const COMBINED_OPTIONS_EXACT = new Set([
  'option',
  'options',
  'choices',
  'choice',
  'alternatives',
  'answer choices',
  'answer options',
]);

/**
 * Letter for a per-option header such as "Option A", "A", "(b)", "Choice 3", "opt c".
 * @param {string} norm normalised header
 * @returns {OptionLetter|null}
 */
export function optionLetterFromHeader(norm) {
  let m = norm.match(/^(?:option|options|opt|choice|alternative|alt)?\s*([a-e])$/);
  if (m) return /** @type {OptionLetter} */ (m[1].toUpperCase());
  m = norm.match(/^(?:option|opt|choice|alternative|alt)\s*([1-5])$/);
  if (m) return LETTERS[parseInt(m[1], 10) - 1];
  return null;
}

/**
 * Score each column for each role, then assign greedily so one column holds one role.
 * @param {string[]} headers
 * @returns {ColumnMapping}
 */
export function autoMap(headers) {
  const norms = headers.map(normalizeHeader);
  /** @type {ColumnMapping} */
  const mapping = { number: null, question: null, answer: null, options: [] };
  const used = new Set();

  const pick = (/** @type {(n:string)=>number} */ score) => {
    let best = -1;
    let bestScore = 0;
    norms.forEach((n, i) => {
      if (used.has(i)) return;
      const s = score(n);
      if (s > bestScore) {
        best = i;
        bestScore = s;
      }
    });
    if (best >= 0) used.add(best);
    return best >= 0 ? best : null;
  };

  // Number first so "Question No" never becomes the question column.
  mapping.number = pick((n) =>
    NUMBER_EXACT.has(n) ? 3 : /^(?:q|ques|question|item|s|sl|sr)?\s*(?:no|num|number|#)$/.test(n) ? 2 : 0,
  );
  mapping.answer = pick((n) =>
    ANSWER_EXACT.has(n)
      ? 3
      : /\b(?:answer|ans|correct|solution)\b/.test(n) && !/\boptions?\b|\bchoices?\b/.test(n)
        ? 1
        : 0,
  );

  /** @type {{letter: OptionLetter, col: number}[]} */
  const perOption = [];
  norms.forEach((n, i) => {
    if (used.has(i)) return;
    const letter = optionLetterFromHeader(n);
    if (letter && !perOption.some((o) => o.letter === letter)) perOption.push({ letter, col: i });
  });
  // A bare "Q" header is the question, never option letter-like; handled by exclusions above.
  if (perOption.length >= 2) {
    perOption.forEach((o) => used.add(o.col));
    mapping.options = perOption.sort((a, b) => a.letter.localeCompare(b.letter));
  } else {
    const combined = pick((n) => (COMBINED_OPTIONS_EXACT.has(n) ? 3 : /\b(?:options|choices)\b/.test(n) ? 1 : 0));
    if (combined !== null) mapping.options = { combinedCol: combined };
  }

  mapping.question = pick((n) =>
    QUESTION_EXACT.has(n) ? 3 : /\bquestions?\b|\bques\b/.test(n) ? 2 : /\b(?:text|statement|item)\b/.test(n) ? 1 : 0,
  );
  return mapping;
}

/**
 * Infer a mapping from cell contents when there is no header row (or the header
 * matched nothing useful). Heuristic, and always user-editable in the UI.
 * @param {string[][]} rows data rows
 * @param {number} width column count
 * @returns {ColumnMapping}
 */
export function inferMappingFromData(rows, width) {
  /** @type {ColumnMapping} */
  const mapping = { number: null, question: null, answer: null, options: [] };
  if (!rows.length || width === 0) return mapping;
  const sample = rows.slice(0, 200);
  const ratio = (/** @type {number} */ col, /** @type {(v:string)=>boolean} */ test) => {
    const vals = sample.map((r) => (r[col] ?? '').trim()).filter(Boolean);
    return vals.length ? vals.filter(test).length / vals.length : 0;
  };
  const avgLen = (/** @type {number} */ col) => {
    const vals = sample.map((r) => (r[col] ?? '').trim()).filter(Boolean);
    return vals.length ? vals.reduce((s, v) => s + v.length, 0) / vals.length : 0;
  };
  const cols = [...Array(width).keys()];
  const used = new Set();

  const numberCol = cols.find((c) => ratio(c, (v) => /^(?:q\s*)?\d+[.)]?$/i.test(v)) >= 0.8);
  if (numberCol !== undefined) {
    mapping.number = numberCol;
    used.add(numberCol);
  }
  // Answer: mostly single letters, else the right-most short column.
  let answerCol = [...cols].reverse().find((c) => !used.has(c) && ratio(c, (v) => /^\(?[a-e][).:]?$/i.test(v)) >= 0.8);
  let question = null;
  let bestLen = 0;
  for (const c of cols) {
    if (used.has(c) || c === answerCol) continue;
    const l = avgLen(c);
    if (l > bestLen) {
      bestLen = l;
      question = c;
    }
  }
  if (question !== null) {
    mapping.question = question;
    used.add(question);
  }
  if (answerCol === undefined) {
    const last = [...cols].reverse().find((c) => !used.has(c));
    if (last !== undefined && last > (question ?? -1)) answerCol = last;
  }
  if (answerCol !== undefined) {
    mapping.answer = answerCol;
    used.add(answerCol);
  }
  // Options: unused columns between question and answer.
  if (question !== null && mapping.answer !== null) {
    const between = cols.filter((c) => c > question && c < /** @type {number} */ (mapping.answer) && !used.has(c));
    if (between.length === 1) mapping.options = { combinedCol: between[0] };
    else mapping.options = between.slice(0, 5).map((col, i) => ({ letter: LETTERS[i], col }));
  }
  return mapping;
}

/**
 * True when the mapping has the minimum needed to read rows (FR-13).
 * @param {ColumnMapping} m
 */
export function isMappingPlayable(m) {
  return m.question !== null && m.answer !== null;
}
