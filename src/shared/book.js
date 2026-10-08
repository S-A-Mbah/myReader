/**
 * PDF book → readable text with sections. Pure module (no pdf.js here), shared by
 * the browser loader and the Node tests.
 *
 * Pipeline: page text items → lines → drop running headers/footers and page numbers
 * → join lines into paragraphs (re-joining hyphenated words) → one book text with
 * page offsets → sections from the PDF outline ("the book's legend"), or page ranges
 * when the PDF has no outline.
 */
import { chunkText } from './chunker.js';

/** Hard caps so an enormous PDF degrades gracefully instead of freezing the tab. */
export const MAX_BOOK_PAGES = 3000;
export const MAX_BOOK_CHARS = 6_000_000;
/** Page-range size used when a PDF has no outline. */
export const FALLBACK_SECTION_PAGES = 10;

/**
 * @typedef {{str: string, hasEOL?: boolean, transform?: number[], height?: number}} PdfTextItem
 * @typedef {{text: string, y: number, h: number}} Line
 * @typedef {{title: string, depth: number, page: number}} OutlineEntry  page is 0-based
 * @typedef {{title: string, depth: number, page: number, start: number, segment: number}} Section
 * @typedef {Object} Book
 * @property {string} title
 * @property {string} text          whole book, paragraphs separated by blank lines
 * @property {number[]} pageStarts  char offset where each page starts in `text`
 * @property {Section[]} sections   in reading order
 * @property {import('./chunker.js').TextChunk[]} segments  sentences, as in text mode
 * @property {boolean} fromOutline  false when sections are page ranges
 * @property {string[]} warnings
 */

/**
 * Group pdf.js text items into visual lines.
 * A line ends at `hasEOL`, or when the baseline moves by more than half a line height.
 * @param {PdfTextItem[]} items
 * @returns {Line[]}
 */
export function itemsToLines(items) {
  /** @type {Line[]} */
  const lines = [];
  let text = '';
  let y = NaN;
  let h = 0;
  const flush = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) lines.push({ text: t, y, h: h || 10 });
    text = '';
    y = NaN;
    h = 0;
  };
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    const iy = Array.isArray(it.transform) ? Number(it.transform[5]) : NaN;
    const ih = Math.abs(Number(it.height) || 0);
    if (text && Number.isFinite(y) && Number.isFinite(iy) && Math.abs(iy - y) > Math.max(h, ih, 4) * 0.5) flush();
    if (!text && Number.isFinite(iy)) y = iy;
    if (ih > h) h = ih;
    // pdf.js splits words across items without spaces; keep its own spacing.
    text += it.str;
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

const PAGE_NUMBER = /^(?:page\s*)?[-–—(]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[-–—)]?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

/** Normalise a line for header/footer comparison: digits vary page to page. */
const headerKey = (/** @type {string} */ s) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/**
 * Remove page numbers and running headers/footers: short lines in the first or last
 * two lines of a page that repeat on many pages ("Chapter 3 · Cells", "Biology 101").
 * @param {Line[][]} pages
 * @returns {Line[][]}
 */
export function stripRunningLines(pages) {
  // Headers/footers live in the top and bottom lines. On short pages (chapter ends) a
  // 2+2 window would cover body text too, so only the very first and last line count.
  const edge = (/** @type {Line[]} */ lines) =>
    lines.length >= 8 ? [...lines.slice(0, 2), ...lines.slice(-2)] : [...lines.slice(0, 1), ...lines.slice(-1)];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const lines of pages) {
    const seen = new Set(edge(lines).map((l) => headerKey(l.text)));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  return pages.map((lines) => {
    const edges = new Set(edge(lines));
    return lines.filter((l) => {
      if (PAGE_NUMBER.test(l.text)) return false;
      if (!edges.has(l) || l.text.length > 90) return true;
      return (counts.get(headerKey(l.text)) ?? 0) < threshold;
    });
  });
}

/**
 * Join a page's lines into paragraphs. A large vertical gap, or a short line that
 * ends a sentence, starts a new paragraph. "exam-" + "ple" becomes "example".
 * @param {Line[]} lines
 * @returns {string}
 */
export function linesToText(lines) {
  if (!lines.length) return '';
  const widths = lines.map((l) => l.text.length).sort((a, b) => a - b);
  const typical = widths[Math.floor(widths.length * 0.75)] || 60;
  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const gap = Number.isFinite(prev.y) && Number.isFinite(cur.y) ? Math.abs(prev.y - cur.y) : 0;
    const lineStep = Math.max(prev.h, cur.h) * 1.25;
    const bigGap = gap > lineStep * 1.6;
    const shortEnd = /[.!?:"”)]$/.test(prev.text) && prev.text.length < typical * 0.7;
    if (bigGap || shortEnd) {
      out += `\n\n${cur.text}`;
    } else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(cur.text)) {
      out = out.slice(0, -1) + cur.text; // hyphenated line break
    } else {
      out += ` ${cur.text}`;
    }
  }
  return out;
}

/** Collapse whitespace and case for fuzzy title matching. */
const loose = (/** @type {string} */ s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Where does a heading start inside a page's text? Falls back to the page start.
 * @param {string} pageText
 * @param {string} title
 */
export function findHeading(pageText, title) {
  const want = loose(title);
  if (!want) return 0;
  // Build a loose copy of the page with a map back to original offsets.
  let norm = '';
  /** @type {number[]} */
  const map = [];
  let prevSpace = true;
  for (let i = 0; i < pageText.length; i++) {
    const ch = pageText[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm += ch.toLowerCase();
      map.push(i);
      prevSpace = false;
    } else if (!prevSpace) {
      norm += ' ';
      map.push(i);
      prevSpace = true;
    }
  }
  let at = norm.indexOf(want);
  // Long titles are often wrapped or abbreviated on the page: try the first words.
  if (at < 0) {
    const head = want.split(' ').slice(0, 4).join(' ');
    if (head.length >= 6) at = norm.indexOf(head);
  }
  return at < 0 ? 0 : map[at];
}

/**
 * Index of the sentence segment that contains (or follows) a character offset.
 * @param {{start: number, end: number}[]} segments
 * @param {number} offset
 */
export function segmentAt(segments, offset) {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = segments.length ? segments.length - 1 : 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].end > offset) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

/**
 * Section index that contains a segment index (sections are sorted by `segment`).
 * @param {Section[]} sections
 * @param {number} segment
 */
export function sectionAt(sections, segment) {
  let lo = 0;
  let hi = sections.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].segment <= segment) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Page index (0-based) for a character offset.
 * @param {number[]} pageStarts
 * @param {number} offset
 */
export function pageAt(pageStarts, offset) {
  let lo = 0;
  let hi = pageStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageStarts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Flatten the outline tree into [{title, depth, page}] in document order.
 * Destinations are either named (string) or explicit arrays whose first element is a
 * page reference (or, in some producers, a 0-based page number).
 * Takes the pdf.js document object but does not import pdf.js, so it runs anywhere.
 * @param {any} doc pdf.js PDFDocumentProxy
 * @param {any[]} nodes
 * @param {number} depth
 * @param {{title: string, depth: number, page: number}[]} out
 */
export async function flattenOutline(doc, nodes, depth, out) {
  for (const node of nodes ?? []) {
    let page = -1;
    try {
      const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
      const target = Array.isArray(dest) ? dest[0] : null;
      if (typeof target === 'number') page = target;
      else if (target && typeof target === 'object') page = await doc.getPageIndex(target);
    } catch {
      page = -1; // broken link in the PDF: keep the children, skip this entry
    }
    if (page >= 0) out.push({ title: String(node.title ?? ''), depth, page });
    if (node.items?.length && out.length < 5000) await flattenOutline(doc, node.items, depth + 1, out);
  }
}

/**
 * Assemble a book from per-page lines and the flattened outline.
 * @param {{title: string, pages: Line[][], outline: OutlineEntry[]}} input
 * @returns {Book}
 */
export function buildBook({ title, pages, outline }) {
  /** @type {string[]} */
  const warnings = [];
  let pageLines = pages;
  if (pageLines.length > MAX_BOOK_PAGES) {
    warnings.push(`Only the first ${MAX_BOOK_PAGES} of ${pageLines.length} pages were loaded.`);
    pageLines = pageLines.slice(0, MAX_BOOK_PAGES);
  }
  const cleaned = stripRunningLines(pageLines);
  const pageTexts = cleaned.map(linesToText);

  let text = '';
  /** @type {number[]} */
  const pageStarts = [];
  for (const t of pageTexts) {
    pageStarts.push(text.length);
    if (text.length + t.length > MAX_BOOK_CHARS) {
      warnings.push('This book is very long; reading stops partway through.');
      break;
    }
    text += t ? `${t}\n\n` : '';
  }
  while (pageStarts.length < pageTexts.length) pageStarts.push(text.length);

  const emptyPages = pageTexts.filter((t) => !t.trim()).length;
  if (pageTexts.length && emptyPages / pageTexts.length > 0.5) {
    warnings.push(
      emptyPages === pageTexts.length
        ? 'This PDF has no selectable text (it is probably scanned images), so there is nothing to read.'
        : `${emptyPages} of ${pageTexts.length} pages have no selectable text and are skipped.`,
    );
  }

  const segments = chunkText(text);

  /** @type {Section[]} */
  let sections = [];
  const valid = outline.filter((o) => o.title.trim() && o.page >= 0 && o.page < pageStarts.length);
  for (const o of valid) {
    const local = findHeading(pageTexts[o.page] ?? '', o.title);
    const start = pageStarts[o.page] + local;
    sections.push({ title: o.title.trim(), depth: Math.min(o.depth, 4), page: o.page, start, segment: 0 });
  }
  // Keep reading order even if the outline lists entries out of page order.
  sections.sort((a, b) => a.start - b.start);
  const fromOutline = sections.length > 0;
  if (!fromOutline && pageStarts.length) {
    for (let p = 0; p < pageStarts.length; p += FALLBACK_SECTION_PAGES) {
      const last = Math.min(p + FALLBACK_SECTION_PAGES, pageStarts.length);
      sections.push({ title: `Pages ${p + 1} to ${last}`, depth: 0, page: p, start: pageStarts[p], segment: 0 });
    }
  }
  // Front matter before the first outline entry becomes its own section.
  if (fromOutline && sections[0].start > 0 && segments.length && segments[0].start < sections[0].start) {
    sections.unshift({ title: 'Beginning', depth: 0, page: 0, start: 0, segment: 0 });
  }
  for (const s of sections) s.segment = segmentAt(segments, s.start);
  sections = sections.filter((s) => segments.length && s.segment < segments.length);

  return { title, text, pageStarts, sections, segments, fromOutline, warnings };
}

/**
 * Read every page's text and the outline from an open pdf.js document, then build
 * the book. Takes the document object (no pdf.js import), so the browser loader and
 * the Node tests run exactly this code.
 * @param {any} doc pdf.js PDFDocumentProxy
 * @param {{onProgress?: (done: number, total: number) => void, signal?: AbortSignal, fallbackTitle?: string}} [opts]
 * @returns {Promise<Book>}
 */
export async function extractBook(doc, opts = {}) {
  const total = Math.min(doc.numPages, MAX_BOOK_PAGES + 1);
  /** @type {Line[][]} */
  const pages = [];
  for (let p = 1; p <= total; p++) {
    if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    try {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(itemsToLines(content.items));
      page.cleanup();
    } catch {
      pages.push([]); // one damaged page should not lose the whole book
    }
    opts.onProgress?.(p, total);
  }
  /** @type {OutlineEntry[]} */
  const outline = [];
  try {
    await flattenOutline(doc, await doc.getOutline(), 0, outline);
  } catch {
    /* no usable outline: buildBook falls back to page ranges */
  }
  let title = opts.fallbackTitle ?? 'Untitled';
  try {
    const meta = await doc.getMetadata();
    const t = meta?.info?.Title;
    if (typeof t === 'string' && t.trim().length > 2) title = t.trim();
  } catch {
    /* metadata is optional */
  }
  return buildBook({ title, pages, outline });
}

/**
 * Book → storable object. Sentence segments are dropped (they are most of the size and
 * are rebuilt deterministically from the text by restoreBook).
 * @param {Book} book
 */
export function serializeBook(book) {
  const { title, text, pageStarts, sections, fromOutline, warnings } = book;
  return { v: 1, title, text, pageStarts, sections, fromOutline, warnings };
}

/**
 * Stored object → Book, or null when it is missing, corrupt or from another version.
 * Re-chunking the same text gives the same segments, so section indices stay valid;
 * sections that no longer line up are dropped rather than trusted.
 * @param {any} saved
 * @returns {Book | null}
 */
export function restoreBook(saved) {
  if (!saved || saved.v !== 1 || typeof saved.text !== 'string' || !Array.isArray(saved.pageStarts)) return null;
  if (!Array.isArray(saved.sections)) return null;
  const segments = chunkText(saved.text);
  const sections = saved.sections.filter(
    (/** @type {any} */ s) =>
      s && typeof s.title === 'string' && Number.isInteger(s.segment) && s.segment >= 0 && s.segment < segments.length,
  );
  return {
    title: typeof saved.title === 'string' ? saved.title : 'Book',
    text: saved.text,
    pageStarts: saved.pageStarts.filter((/** @type {unknown} */ n) => Number.isInteger(n)),
    sections,
    segments,
    fromOutline: Boolean(saved.fromOutline),
    warnings: Array.isArray(saved.warnings) ? saved.warnings.filter((w) => typeof w === 'string') : [],
  };
}
