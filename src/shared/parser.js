/**
 * Input detection and parsing (PRD §6). Pure module shared by the browser and Node.
 *
 * Order: HTML <table> → Markdown pipe table → TSV → CSV → plain text.
 */
import Papa from './papa.js';
import { extractHtmlTable, hasHtmlTable, decodeEntities } from './html-table.js';
import { autoMap, inferMappingFromData, isMappingPlayable } from './mapping.js';
import { chunkText } from './chunker.js';

/** Hard caps so a giant or hostile paste degrades gracefully instead of freezing the tab. */
export const MAX_INPUT_CHARS = 2_000_000;
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 40;

/**
 * @typedef {import('./mapping.js').ColumnMapping} ColumnMapping
 * @typedef {import('./chunker.js').TextChunk} TextChunk
 * @typedef {'html'|'tsv'|'csv'|'markdown'} TableSource
 * @typedef {{kind:'text', text:string, chunks:string[], segments:TextChunk[], warnings:string[]}} TextResult
 * @typedef {{kind:'table', headers:string[], rows:string[][], source:TableSource, mapping:ColumnMapping,
 *            warnings:string[], hasHeader:boolean}} TableResult
 * @typedef {TextResult | TableResult} ParsedInput
 * @typedef {{mode?: 'auto'|'text'|'table', headerRow?: number, maxChunkChars?: number}} ParseOptions
 */

/**
 * Collapse internal whitespace/newlines to single spaces and trim (FR-19).
 * @param {unknown} v
 */
export function cleanCell(v) {
  return String(v ?? '')
    .replace(/\p{Cf}+/gu, '') // zero-width spaces, BOMs, soft hyphens
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} line */
function splitPipeRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const MD_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Parse a Markdown pipe table, if the text contains one.
 * @param {string} text
 * @returns {string[][] | null}
 */
export function parseMarkdownTable(text) {
  const lines = text.split('\n');
  const sepIdx = lines.findIndex((l, i) => i > 0 && l.includes('-') && l.includes('|') && MD_SEPARATOR.test(l));
  if (sepIdx < 1 || !lines[sepIdx - 1].includes('|')) return null;
  const header = splitPipeRow(lines[sepIdx - 1]);
  const rows = [header];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      // A blank line ends the table unless more pipe rows follow immediately after.
      if (lines[i + 1]?.includes('|')) continue;
      break;
    }
    if (!l.includes('|')) break;
    rows.push(splitPipeRow(l));
  }
  return rows.length >= 2 ? rows : null;
}

/**
 * Most common column count among rows with ≥2 columns, and how many rows have it.
 * @param {string[][]} rows
 */
function modalWidth(rows) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const r of rows) if (r.length >= 2) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  let width = 0;
  let count = 0;
  for (const [w, c] of counts) if (c > count || (c === count && w > width)) [width, count] = [w, c];
  return { width, count };
}

/**
 * @param {string} text
 * @param {string} delimiter '' to auto-detect
 * @returns {string[][]}
 */
function papaRows(text, delimiter) {
  const res = Papa.parse(text, {
    delimiter,
    delimitersToGuess: [',', ';'],
    skipEmptyLines: 'greedy',
  });
  return /** @type {string[][]} */ (res.data).filter((r) => Array.isArray(r));
}

/**
 * Try every table format in PRD order. Returns null for plain text.
 * @param {{text:string, html:string}} raw
 * @param {boolean} lenient When the user forced Table mode, accept weaker evidence.
 * @returns {{rows:string[][], source:TableSource} | null}
 */
function detectTable(raw, lenient) {
  if (hasHtmlTable(raw.html)) {
    const rows = extractHtmlTable(raw.html);
    if (rows && rows.length >= 2 && rows[0].length >= 2) return { rows, source: 'html' };
  }
  const text = raw.text;
  if (!text.trim()) return null;

  const md = parseMarkdownTable(text);
  if (md) return { rows: md, source: 'markdown' };

  const tabLines = text.split('\n').filter((l) => l.includes('\t')).length;
  if (tabLines >= 2 || (lenient && tabLines >= 1)) {
    const rows = papaRows(text, '\t');
    const { width, count } = modalWidth(rows);
    if (width >= 2 && (count >= 2 || lenient)) return { rows, source: 'tsv' };
  }

  const csv = papaRows(text, '');
  if (csv.length >= 2) {
    const { width, count } = modalWidth(csv);
    const minCols = lenient ? 2 : 3;
    if (width >= minCols && count / csv.length >= 0.8) return { rows: csv, source: 'csv' };
  }
  return null;
}

/**
 * Crude HTML → text for a forced Plain Text read of an HTML-only paste.
 * @param {string} html
 */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head)[\s>][\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]*>/g, ''),
  );
}

/**
 * Build a table result from raw rows: header handling, cleaning, empty-row removal,
 * auto-mapping and warnings.
 * @param {string[][]} rawRows
 * @param {TableSource} source
 * @param {number} headerRow 1-based header row; 0 = no header
 * @returns {TableResult}
 */
export function buildTable(rawRows, source, headerRow) {
  /** @type {string[]} */
  const warnings = [];
  let width = rawRows.reduce((w, r) => Math.max(w, r.length), 0);
  if (width > MAX_COLUMNS) {
    warnings.push(`Only the first ${MAX_COLUMNS} of ${width} columns are shown.`);
    width = MAX_COLUMNS;
  }
  const cleaned = rawRows.map((r) => {
    const row = r.slice(0, width).map(cleanCell);
    while (row.length < width) row.push('');
    return row;
  });

  const hIdx = Math.max(0, Math.min(headerRow, cleaned.length)) - 1;
  const hasHeader = hIdx >= 0 && hIdx < cleaned.length;
  const headers = hasHeader
    ? cleaned[hIdx].map((h, i) => h || `Column ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  // Rows above the header (titles, notes) are ignored; fully empty rows skipped (FR-20).
  let rows = cleaned.slice(hasHeader ? hIdx + 1 : 0).filter((r) => r.some((c) => c !== ''));
  if (rows.length > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS} of ${rows.length} rows were loaded.`);
    rows = rows.slice(0, MAX_ROWS);
  }

  let mapping = hasHeader ? autoMap(headers) : inferMappingFromData(rows, width);
  if (hasHeader && !isMappingPlayable(mapping)) {
    // Header text matched nothing useful: fill the gaps from the cell contents.
    const guess = inferMappingFromData(rows, width);
    const taken = new Set([mapping.number, mapping.question, mapping.answer].filter((v) => v !== null));
    for (const role of /** @type {const} */ (['question', 'answer'])) {
      const g = guess[role];
      if (mapping[role] === null && g !== null && !taken.has(g)) {
        mapping = { ...mapping, [role]: g };
        taken.add(g);
      }
    }
    if (isMappingPlayable(mapping)) warnings.push('Some columns were guessed from their contents. Check the mapping.');
  }
  if (mapping.question === null) warnings.push('No Question column found. Pick one in the column mapping.');
  if (mapping.answer === null) warnings.push('No Answer column found. Pick one in the column mapping.');
  if (!rows.length) warnings.push('The table has no data rows.');
  return { kind: 'table', headers, rows, source, mapping, warnings, hasHeader };
}

/**
 * Detect and parse pasted content.
 * @param {{text?: string, html?: string}} raw
 * @param {ParseOptions} [opts]
 * @returns {ParsedInput}
 */
export function parseInput(raw, opts = {}) {
  const mode = opts.mode ?? 'auto';
  const headerRow = opts.headerRow ?? 1;
  /** @type {string[]} */
  const warnings = [];
  let text = typeof raw?.text === 'string' ? raw.text : '';
  let html = typeof raw?.html === 'string' ? raw.html : '';
  if (text.length > MAX_INPUT_CHARS) {
    warnings.push(`Input was truncated to ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters.`);
    text = text.slice(0, MAX_INPUT_CHARS);
  }
  if (html.length > MAX_INPUT_CHARS * 4) html = ''; // too large to tokenize; fall back to text
  text = text.replace(/^\p{Cf}+/u, '').replace(/\r\n?/g, '\n');

  if (mode !== 'text') {
    const found = detectTable({ text, html }, mode === 'table');
    if (found) {
      const table = buildTable(found.rows, found.source, headerRow);
      table.warnings.unshift(...warnings);
      return table;
    }
    if (mode === 'table') {
      return {
        kind: 'table',
        headers: [],
        rows: [],
        source: 'tsv',
        mapping: { number: null, question: null, answer: null, options: [] },
        warnings: [
          ...warnings,
          'Could not find any columns. Paste from a spreadsheet, or use CSV, TSV or a Markdown table.',
        ],
        hasHeader: headerRow > 0,
      };
    }
  }

  const plain = text.trim() ? text : html ? htmlToText(html) : '';
  const segments = chunkText(plain, { maxChars: opts.maxChunkChars });
  return { kind: 'text', text: plain, chunks: segments.map((s) => s.text), segments, warnings };
}
