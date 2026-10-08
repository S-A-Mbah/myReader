/**
 * Table and text rendering plus highlighting (FR-9, FR-23 to FR-26).
 * All user content is inserted with textContent, never as HTML.
 */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Scroll `node` into the middle of `container` when it is not already visible.
 * @param {HTMLElement} node
 * @param {HTMLElement} container
 */
function reveal(node, container) {
  const c = container.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const header = container.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  // Visible area = the panel ∩ the window, minus the player tray. On phones and tablets
  // the whole page scrolls (the panel is never "out of view") and the tray floats over
  // the bottom, so checking the panel alone would miss off-screen sentences.
  const tray = document.getElementById('player')?.getBoundingClientRect().height ?? 0;
  const top = Math.max(c.top + header, 0);
  const bottom = Math.min(c.bottom, window.innerHeight - tray);
  if (r.top >= top && r.bottom <= bottom) return;
  node.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

export class View {
  /**
   * @param {{empty: HTMLElement, tableWrap: HTMLElement, table: HTMLTableElement, thead: HTMLElement,
   *          tbody: HTMLElement, textView: HTMLElement, tableHead: HTMLElement, caption: HTMLElement}} els
   */
  constructor(els) {
    this.els = els;
    /** @type {'empty'|'table'|'text'} */
    this.kind = 'empty';
    /** @type {HTMLElement[]} */
    this.rows = [];
    /** @type {HTMLElement[]} */
    this.scriptCells = [];
    this.current = -1;
    this.cursor = -1;
    /** Rendered segment window in text mode (whole text unless a book section). */
    this.range = { from: 0, to: 0 };
    // One shared "speaking" indicator, moved into the current row's number cell.
    this.eq = el('span', 'eq');
    this.eq.setAttribute('aria-hidden', 'true');
    this.eq.append(el('i'), el('i'), el('i'));
  }

  showEmpty() {
    this.kind = 'empty';
    this.rows = [];
    this.scriptCells = [];
    this.current = -1;
    this.cursor = -1;
    this.els.empty.classList.remove('hidden');
    this.els.tableWrap.classList.add('hidden');
    this.els.tableHead.classList.add('hidden');
    this.els.textView.classList.add('hidden');
    this.els.thead.replaceChildren();
    this.els.tbody.replaceChildren();
    this.els.textView.replaceChildren();
  }

  /**
   * @param {import('/shared/parser.js').TableResult} parsed
   * @param {{text:string, skipped?:string}[]} scripts
   */
  showTable(parsed, scripts) {
    this.kind = 'table';
    const { thead, tbody } = this.els;
    const roles = roleByColumn(parsed.mapping);

    const htr = el('tr');
    htr.append(el('th', 'col-idx', '#'));
    parsed.headers.forEach((h, i) => {
      const th = el('th', roles.has(i) ? 'is-mapped' : '', h);
      th.scope = 'col';
      // Tag the role only when it adds information ("No" → Number), not "Question" → Question.
      const role = roles.get(i);
      if (role && role.toLowerCase() !== h.trim().toLowerCase()) th.append(el('span', 'role', role));
      htr.append(th);
    });
    const sth = el('th', 'script', 'Spoken script');
    sth.scope = 'col';
    htr.append(sth);
    thead.replaceChildren(htr);

    const frag = document.createDocumentFragment();
    this.rows = [];
    this.scriptCells = [];
    parsed.rows.forEach((row, r) => {
      const tr = el('tr');
      tr.dataset.i = String(r);
      tr.id = `row-${r}`;
      const idx = el('td', 'col-idx');
      idx.append(el('span', 'n', String(r + 1)));
      tr.append(idx);
      row.forEach((cell, c) => {
        const role = roles.get(c);
        const cls = role === 'Question' ? 'is-question' : role === 'Answer' ? 'is-answer' : '';
        tr.append(el('td', cls, cell));
      });
      const sc = el('td', 'script');
      tr.append(sc);
      this.rows.push(tr);
      this.scriptCells.push(sc);
      frag.append(tr);
    });
    tbody.replaceChildren(frag);
    this.updateScripts(scripts);

    const skipped = scripts.filter((s) => s.skipped).length;
    this.els.caption.textContent =
      `${parsed.rows.length} ${parsed.rows.length === 1 ? 'row' : 'rows'}` + (skipped ? ` · ${skipped} skipped` : '');
    this.els.empty.classList.add('hidden');
    this.els.textView.classList.add('hidden');
    this.els.tableWrap.classList.remove('hidden');
    this.els.tableHead.classList.remove('hidden');
    this.current = -1;
    this.cursor = -1;
  }

  /** @param {{text:string, skipped?:string}[]} scripts */
  updateScripts(scripts) {
    scripts.forEach((s, i) => {
      const cell = this.scriptCells[i];
      const row = this.rows[i];
      if (!cell || !row) return;
      const text = s.skipped ? `Skipped: ${s.skipped.toLowerCase()}` : s.text;
      // Touch only cells that changed: on large tables most edits change a few rows.
      if (cell.textContent !== text) cell.textContent = text;
      row.classList.toggle('skipped', Boolean(s.skipped));
    });
  }

  /**
   * Render text as clickable sentences. For a book only one section is rendered
   * (`from`..`to` segment indices) so a 500-page PDF does not put 30k nodes in the DOM;
   * `rows` stays indexed by absolute segment number.
   * @param {{text: string, segments: {start: number, end: number}[]}} parsed
   * @param {{from?: number, to?: number, heading?: string}} [range]
   */
  showText(parsed, range = {}) {
    this.kind = 'text';
    const view = this.els.textView;
    const wrap = el('div');
    const from = range.from ?? 0;
    const to = Math.min(range.to ?? parsed.segments.length, parsed.segments.length);
    this.range = { from, to };
    // Show the section title as a heading, unless the book's own heading text already
    // opens the section (it is read aloud, so it stays as a sentence).
    const loose = (/** @type {string} */ s) =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const firstText = parsed.segments[from]
      ? parsed.text.slice(parsed.segments[from].start, parsed.segments[from].end)
      : '';
    if (range.heading && !loose(firstText).startsWith(loose(range.heading)))
      wrap.append(el('h2', 'section-title', range.heading));
    let pos = range.from === undefined ? 0 : (parsed.segments[from]?.start ?? 0);
    this.rows = [];
    for (let i = from; i < to; i++) {
      const seg = parsed.segments[i];
      if (seg.start > pos) wrap.append(document.createTextNode(parsed.text.slice(pos, seg.start)));
      const span = el('span', 's', parsed.text.slice(seg.start, seg.end));
      span.dataset.i = String(i);
      this.rows[i] = span;
      wrap.append(span);
      pos = seg.end;
    }
    if (range.to === undefined && pos < parsed.text.length)
      wrap.append(document.createTextNode(parsed.text.slice(pos)));
    view.replaceChildren(wrap);
    view.scrollTop = 0;
    this.els.empty.classList.add('hidden');
    this.els.tableWrap.classList.add('hidden');
    this.els.tableHead.classList.add('hidden');
    view.classList.remove('hidden');
    this.current = -1;
    this.cursor = -1;
  }

  /**
   * Highlight the item being read and keep it in view (FR-24).
   * @param {number} i -1 clears
   * @param {{scroll?: boolean}} [opts]
   */
  setCurrent(i, opts = {}) {
    if (this.current >= 0) {
      this.rows[this.current]?.classList.remove('current');
      this.rows[this.current]?.removeAttribute('aria-current');
    }
    this.current = i;
    const node = this.rows[i];
    if (!node) return;
    node.classList.add('current');
    node.setAttribute('aria-current', 'true');
    if (this.kind === 'table') node.firstElementChild?.append(this.eq);
    if (opts.scroll !== false) reveal(node, this.kind === 'table' ? this.els.tableWrap : this.els.textView);
    this.setCursor(i, false);
  }

  /**
   * Bring the current sentence or row back into view and flash it briefly, so the
   * reader can find their place again after scrolling away.
   */
  revealCurrent() {
    const node = this.rows[this.current];
    if (!node) return false;
    reveal(node, this.kind === 'table' ? this.els.tableWrap : this.els.textView);
    node.classList.remove('located');
    void node.offsetWidth; // restart the flash if clicked twice in a row
    node.classList.add('located');
    setTimeout(() => node.classList.remove('located'), 900);
    return true;
  }

  /**
   * Keyboard cursor in the table (roving focus via aria-activedescendant).
   * @param {number} i
   * @param {boolean} [scroll]
   */
  setCursor(i, scroll = true) {
    if (this.kind !== 'table') return;
    if (this.cursor >= 0) this.rows[this.cursor]?.classList.remove('cursor');
    this.cursor = Math.max(0, Math.min(i, this.rows.length - 1));
    const node = this.rows[this.cursor];
    if (!node) return;
    node.classList.add('cursor');
    this.els.tbody.setAttribute('aria-activedescendant', node.id);
    if (scroll) reveal(node, this.els.tableWrap);
  }

  /** @param {boolean} on */
  showScripts(on) {
    this.els.table.classList.toggle('no-script', !on);
  }
}

/**
 * Column index → role label, for header tags.
 * @param {import('/shared/mapping.js').ColumnMapping} m
 * @returns {Map<number, string>}
 */
function roleByColumn(m) {
  /** @type {Map<number, string>} */
  const roles = new Map();
  if (m.number !== null) roles.set(m.number, 'Number');
  if (m.question !== null) roles.set(m.question, 'Question');
  if (m.answer !== null) roles.set(m.answer, 'Answer');
  if (Array.isArray(m.options)) for (const o of m.options) roles.set(o.col, `Option ${o.letter}`);
  else if (m.options && typeof m.options.combinedCol === 'number') roles.set(m.options.combinedCol, 'Options');
  return roles;
}
