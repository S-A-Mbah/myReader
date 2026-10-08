/**
 * Extract the first <table> from clipboard HTML. Pure string tokenizer so the same
 * code runs in the browser and in Node tests (no DOM needed).
 *
 * Why not DOMParser: one implementation means the parser behaves identically in
 * tests and in the app, and block-level tags inside cells (Word's <p>, Sheets'
 * <div>) are turned into line breaks, which innerText/textContent do inconsistently.
 * The output is plain strings only; nothing here is ever inserted as HTML.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  bull: '•',
  middot: '·',
  deg: '°',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  copy: '©',
  reg: '®',
  trade: '™',
  shy: '',
  zwj: '',
  zwnj: '',
};

/**
 * Decode HTML character references.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject invalid / surrogate code points rather than throwing.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'tr',
]);
const MAX_SPAN = 50; // cap colspan/rowspan so a hostile paste can't explode memory

/** @param {string} attrs @param {string} name */
function spanAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'));
  const n = m ? parseInt(m[1], 10) : 1;
  return Math.min(Math.max(n || 1, 1), MAX_SPAN);
}

/**
 * Return true when the HTML contains a table element.
 * @param {string|undefined|null} html
 */
export function hasHtmlTable(html) {
  return typeof html === 'string' && /<table[\s>]/i.test(html);
}

/**
 * Extract rows of cell text from the first top-level table in `html`.
 * colspan repeats the value across the spanned columns (PRD §6); rowspan repeats
 * it down the spanned rows so merged cells keep their meaning.
 * @param {string} html
 * @returns {string[][] | null} null when there is no table
 */
export function extractHtmlTable(html) {
  if (!hasHtmlTable(html)) return null;
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|xml)[\s>][\s\S]*?<\/\1\s*>/gi, '');

  const start = cleaned.search(/<table[\s>]/i);
  if (start < 0) return null;

  /** @type {string[][]} */
  const rows = [];
  /** @type {{text:string,colspan:number,rowspan:number}[] | null} */
  let row = null;
  /** @type {{text:string,colspan:number,rowspan:number} | null} */
  let cell = null;
  let depth = 0;
  // col index → {text, remaining} for active rowspans
  /** @type {Map<number,{text:string,remaining:number}>} */
  const carry = new Map();

  const finishCell = () => {
    if (cell && row) row.push(cell);
    cell = null;
  };
  const finishRow = () => {
    finishCell();
    if (!row) return;
    /** @type {string[]} */
    const out = [];
    let col = 0;
    const takeCarry = () => {
      while (carry.has(col)) {
        const c = /** @type {{text:string,remaining:number}} */ (carry.get(col));
        out.push(c.text);
        if (--c.remaining <= 0) carry.delete(col);
        col++;
      }
    };
    for (const c of row) {
      takeCarry();
      const text = c.text
        .replace(/[ \t\f\v\xA0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
      for (let k = 0; k < c.colspan; k++) {
        if (c.rowspan > 1) carry.set(col, { text, remaining: c.rowspan - 1 });
        out.push(text);
        col++;
      }
    }
    takeCarry();
    rows.push(out);
    row = null;
  };

  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const [, slash, rawName, attrs, text] = m;
    if (text !== undefined) {
      if (cell && depth >= 1) cell.text += decodeEntities(text.replace(/\s+/g, ' '));
      continue;
    }
    const name = rawName.toLowerCase();
    const closing = slash === '/';
    if (name === 'table') {
      if (!closing) {
        depth++;
        if (depth > 1 && cell) cell.text += '\n';
      } else {
        depth--;
        if (depth === 0) break; // first table only
        if (cell) cell.text += '\n';
      }
      continue;
    }
    if (depth > 1) {
      // Nested table content is flattened into the outer cell's text.
      if (cell && (BLOCK_TAGS.has(name) || name === 'td' || name === 'th')) cell.text += closing ? '' : ' ';
      if (cell && name === 'tr' && !closing) cell.text += '\n';
      continue;
    }
    if (name === 'tr') {
      if (closing) finishRow();
      else {
        finishRow();
        row = [];
      }
    } else if (name === 'td' || name === 'th') {
      if (closing) finishCell();
      else {
        finishCell();
        if (!row) row = [];
        cell = { text: '', colspan: spanAttr(attrs, 'colspan'), rowspan: spanAttr(attrs, 'rowspan') };
      }
    } else if (cell && BLOCK_TAGS.has(name)) {
      if (name === 'br' || closing || name === 'li') cell.text += '\n';
    }
  }
  finishRow();

  // Drop fully empty rows and pad ragged rows to a rectangle.
  const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));
  const width = nonEmpty.reduce((w, r) => Math.max(w, r.length), 0);
  return nonEmpty.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
}
