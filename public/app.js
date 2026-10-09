/**
 * UI wiring and state. Parsing and script building live in /shared (pure,
 * unit-tested); playback in player.js; rendering in views.js.
 */
import { parseInput } from '/shared/parser.js';
import { hasHtmlTable } from '/shared/html-table.js';
import { isMappingPlayable } from '/shared/mapping.js';
import { chunkText } from '/shared/chunker.js';
import { buildRowScript, DEFAULT_TEMPLATE, DEFAULT_MISSING_ANSWER, unknownPlaceholders } from '/shared/script.js';
import { sectionAt, segmentAt, pageAt, serializeBook, restoreBook } from '/shared/book.js';
import { sessionGet, sessionSet, sessionDelete } from './session.js';
import { Player } from './player.js';
import { View } from './views.js';

/* ------------------------------------------------------------------ dom */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = /** @type {HTMLTextAreaElement} */ ($('input'));
const audio = /** @type {HTMLAudioElement} */ ($('audio'));
const playBtn = /** @type {HTMLButtonElement} */ ($('btn-play'));
const voiceSel = /** @type {HTMLSelectElement} */ ($('voice'));
const speedIn = /** @type {HTMLInputElement} */ ($('speed'));
const volumeIn = /** @type {HTMLInputElement} */ ($('volume'));
const jumpIn = /** @type {HTMLInputElement} */ ($('jump-to'));
const tbody = $('tbody');
const settingsDlg = /** @type {HTMLDialogElement} */ ($('settings'));
const exportDlg = /** @type {HTMLDialogElement} */ ($('export'));

/* ------------------------------------------------------------- settings */

const SETTINGS_KEY = 'readaloud.settings.v1';
const PASTE_KEY = 'readaloud.lastPaste.v1';
const MAX_TTS_CHARS = 1800; // server accepts 2000; leave headroom for pronunciation expansion

const DEFAULTS = {
  voice: 'af_heart',
  speed: 1,
  volume: 1,
  template: DEFAULT_TEMPLATE,
  answerStyle: /** @type {'letterAndText'|'optionText'|'asWritten'} */ ('letterAndText'),
  readOptions: false,
  missingAnswerText: DEFAULT_MISSING_ANSWER,
  rowPauseMs: 1500,
  preAnswerPauseMs: 800,
  sentencePauseMs: 100,
  paragraphPauseMs: 600,
  quizMode: false,
  quizPauseMs: 5000,
  mode: /** @type {'auto'|'text'|'table'} */ ('auto'),
  hasHeader: true,
  headerRow: 1,
  loop: false,
  showScript: true,
  trayCollapsed: false,
  contentsCollapsed: false,
  keepSession: true,
  pronunciations: '',
  theme: /** @type {'system'|'light'|'dark'} */ ('system'),
};

/** localStorage can throw (private mode, quota); the app must work without it. */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    /** @type {typeof DEFAULTS} */
    const out = { ...DEFAULTS };
    for (const k of /** @type {(keyof typeof DEFAULTS)[]} */ (Object.keys(DEFAULTS))) {
      if (saved && typeof saved[k] === typeof DEFAULTS[k]) /** @type {any} */ (out)[k] = saved[k];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}
const settings = loadSettings();

let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
  }, 250);
}

/* ---------------------------------------------------------------- state */

const state = {
  /** @type {{text: string, html: string}} */
  raw: { text: '', html: '' },
  /** @type {import('/shared/parser.js').ParsedInput | null} */
  parsed: null,
  /** @type {import('/shared/script.js').RowScript[]} */
  scripts: [],
  /** @type {import('./player.js').Item[]} */
  items: [],
  ready: false,
  mp3: false,
  /** @type {'loading'|'ready'|'error'|'offline'} */
  model: 'loading',
  /** @type {string|null} */
  exportId: null,
  /** @type {EventSource|null} */
  exportEvents: null,
  /** @type {string|null} */
  lastError: null,
  /** Open PDF book, or null. Pasted text and tables live in `raw`, untouched by books. */
  /** @type {import('/shared/book.js').Book | null} */
  book: null,
  /** Section of the book currently rendered in the text view. */
  bookSection: -1,
  /** @type {AbortController | null} */
  bookLoad: null,
};

/* --------------------------------------------------------------- toasts */

/**
 * Small transient message; errors stay until dismissed or replaced.
 * @param {string} message
 * @param {{kind?: 'info'|'error', ms?: number}} [opts]
 */
function toast(message, opts = {}) {
  const box = $('toasts');
  const t = document.createElement('div');
  t.className = `toast entering ${opts.kind ?? 'info'}`;
  t.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/vendor/icons.svg?v=4#i-${opts.kind === 'error' ? 'alert-circle' : 'check'}`);
  icon.append(use);
  const text = document.createElement('span');
  text.textContent = message;
  t.append(icon, text);
  box.append(t);
  while (box.children.length > 3) box.firstElementChild?.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.remove('entering')));
  const close = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 160);
  };
  t.addEventListener('click', close);
  setTimeout(close, opts.ms ?? (opts.kind === 'error' ? 8000 : 3500));
}

/* ----------------------------------------------------------------- view */

const view = new View({
  empty: $('empty'),
  tableWrap: $('table-wrap'),
  table: /** @type {HTMLTableElement} */ ($('table')),
  thead: $('thead'),
  tbody,
  textView: $('text-view'),
  tableHead: $('table-head'),
  caption: $('table-caption'),
});

/* --------------------------------------------------------------- player */

/**
 * @param {import('./player.js').Segment} seg
 * @param {import('./player.js').Voice} v
 * @param {AbortSignal} signal
 * @param {boolean} prefetch
 */
async function fetchAudio(seg, v, signal, prefetch) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: seg.text, voice: v.voice, speed: v.speed, pauseAfterMs: seg.pauseAfterMs, prefetch }),
    signal,
  });
  if (!res.ok) {
    /** @type {{error?: string}} */
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & {permanent?: boolean}} */ (
      new Error(body.error || `Speech request failed (${res.status}).`)
    );
    err.permanent = res.status >= 400 && res.status < 500;
    throw err;
  }
  return res.blob();
}

/** Set by explicit jumps so the next position change scrolls into view, once. */
let revealNextPosition = false;
/** Whether the view scrolls along with the reader. Off once someone scrolls by hand. */
let following = true;

const player = new Player({
  audio,
  fetchAudio,
  onState: (s) => {
    playBtn.dataset.state = s;
    const playing = s === 'playing' || s === 'buffering';
    $('view').classList.toggle('active', s !== 'stopped');
    $('view').classList.toggle('speaking', s === 'playing');
    playBtn.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)';
    if ('mediaSession' in navigator)
      navigator.mediaSession.playbackState = playing ? 'playing' : s === 'paused' ? 'paused' : 'none';
    if (s === 'playing') state.lastError = null;
    updateProgress();
  },
  onPosition: (i) => {
    if (state.book && i >= 0) ensureBookSection(i);
    // Follow the reader, but not while someone is scrolling around by hand: snapping
    // the view back on every sentence fights them. Following resumes on an explicit
    // jump (Contents, page number, section buttons), on clicking the spoken line in the
    // player, or once the reader brings the spoken sentence back on screen themselves.
    if (revealNextPosition || view.currentInView()) following = true;
    view.setCurrent(i, { scroll: following });
    revealNextPosition = false;
    updateProgress();
    updateMediaSession(i);
    persistPosition(i);
  },
  onError: (err) => {
    state.lastError = err.message;
    toast(err.message, { kind: 'error' });
    updateProgress();
  },
});

/* ---------------------------------------------------------------- items */

/** Parse "written = spoken" lines into replacement rules. */
function pronunciationRules() {
  return settings.pronunciations
    .split('\n')
    .map((l) => l.split('='))
    .filter((p) => p.length === 2 && p[0].trim())
    .map(([from, to]) => {
      // Escape user text so it is matched literally, never as a regex.
      const escaped = from.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu');
      return { re, to: to.trim() };
    });
}

/**
 * @param {string} text
 * @param {{re: RegExp, to: string}[]} rules
 */
function pronounce(text, rules) {
  let out = text;
  for (const r of rules) out = out.replace(r.re, (_m, pre) => `${pre}${r.to}`);
  return out;
}

/**
 * Turn text into one or more TTS segments; only the last gets the pause.
 * @param {string} text
 * @param {number} pauseAfterMs
 * @param {{re: RegExp, to: string}[]} rules
 */
function toSegments(text, pauseAfterMs, rules) {
  const spoken = pronounce(text, rules);
  const pieces = spoken.length > MAX_TTS_CHARS ? chunkText(spoken, { maxChars: 400 }).map((c) => c.text) : [spoken];
  return pieces.map((t, i) => ({ text: t, pauseAfterMs: i === pieces.length - 1 ? pauseAfterMs : 0 }));
}

function scriptSettings() {
  return {
    template: settings.template,
    readOptions: settings.readOptions,
    answerStyle: settings.answerStyle,
    missingAnswerText: settings.missingAnswerText,
  };
}

/** Rebuild scripts and playback items from the parsed input and settings. */
function buildItems() {
  const p = state.parsed;
  const rules = pronunciationRules();
  state.scripts = [];
  if (!p) {
    state.items = [];
    return;
  }
  if (p.kind === 'table') {
    const ss = scriptSettings();
    state.scripts = p.rows.map((r, i) => buildRowScript(r, p.mapping, ss, i + 1));
    const pre = settings.quizMode ? settings.quizPauseMs : settings.preAnswerPauseMs;
    const playable = isMappingPlayable(p.mapping);
    state.items = state.scripts.map((s) => {
      if (s.skipped || !playable) return { segments: [], skipped: true };
      const segments =
        s.parts.question && s.parts.answer
          ? [...toSegments(s.parts.question, pre, rules), ...toSegments(s.parts.answer, settings.rowPauseMs, rules)]
          : toSegments(s.text, settings.rowPauseMs, rules);
      return { segments };
    });
  } else {
    state.items = p.segments.map((c) => ({
      segments: toSegments(c.text, c.paragraphEnd ? settings.paragraphPauseMs : settings.sentencePauseMs, rules),
    }));
  }
}

/* ---------------------------------------------------------------- parse */

function parseOptions() {
  return { mode: settings.mode, headerRow: settings.hasHeader ? settings.headerRow : 0 };
}

/**
 * Full re-parse: new content, mode or header setting.
 * @param {{keepSheet?: boolean}} [opts] keepSheet: leave the Columns sheet as the user has it
 */
function reparse(opts = {}) {
  const hasContent = state.raw.text.trim() || state.raw.html;
  if (state.book) {
    const b = state.book;
    // A book reads exactly like plain text: same segments, pauses and player.
    state.parsed = { kind: 'text', text: b.text, chunks: [], segments: b.segments, warnings: b.warnings };
  } else state.parsed = hasContent ? parseInput(state.raw, parseOptions()) : null;
  buildItems();
  render();
  // The Columns sheet stays tucked away unless the user has to act on it.
  const p = state.parsed;
  const sheet = /** @type {HTMLDetailsElement} */ ($('mapping-sheet'));
  // Open it when the user must act: a required column is missing, or columns were guessed.
  const needsCheck =
    p?.kind === 'table' && (!isMappingPlayable(p.mapping) || p.warnings.some((w) => w.includes('guessed')));
  if (!opts.keepSheet) sheet.open = needsCheck;
  else if (needsCheck) sheet.open = true;
  player.setItems(state.items);
  persistContent();
}

/** Settings that only change the spoken script (template, pauses, mapping). */
function rescript() {
  buildItems();
  if (state.parsed?.kind === 'table') view.updateScripts(state.scripts);
  player.setItems(state.items, { keepPosition: true });
  updateProgress();
}

function render() {
  const p = state.parsed;
  $('input-panel').classList.toggle('has-content', Boolean(p && state.items.length));
  $('input-panel').classList.toggle('has-book', Boolean(state.book));
  renderBook();
  renderBadge();
  renderWarnings();
  renderMapping();
  if (!p || (p.kind === 'text' && !p.segments.length) || (p.kind === 'table' && !p.headers.length)) view.showEmpty();
  else if (p.kind === 'table') {
    view.showTable(p, state.scripts);
    view.showScripts(settings.showScript);
  } else if (state.book) {
    state.bookSection = -1;
    ensureBookSection(0);
  } else view.showText(p);
  jumpIn.max = String(Math.max(1, state.book ? state.book.pageStarts.length : state.items.length));
  updateProgress();
}

function renderBadge() {
  const b = $('detected');
  const p = state.parsed;
  const lead = settings.mode === 'auto' ? 'Detected:' : 'Reading as:';
  if (state.book) {
    const bk = state.book;
    const n = bk.sections.length;
    b.textContent = `Book · ${bk.pageStarts.length} pages · ${n} ${bk.fromOutline ? (n === 1 ? 'section' : 'sections') : 'page ranges'}`;
    b.dataset.kind = 'text';
  } else if (!p) {
    b.textContent = 'Nothing pasted yet';
    b.dataset.kind = '';
  } else if (p.kind === 'table') {
    const src = { html: 'rich paste', tsv: 'spreadsheet', csv: 'CSV', markdown: 'Markdown' }[p.source];
    b.textContent = p.headers.length
      ? `${lead} Table · ${p.headers.length} columns · ${p.rows.length} ${p.rows.length === 1 ? 'row' : 'rows'} · ${src}`
      : `${lead} Table · no columns found`;
    b.dataset.kind = 'table';
  } else {
    const n = p.segments.length;
    b.textContent = n ? `${lead} Text · ${n} ${n === 1 ? 'sentence' : 'sentences'}` : `${lead} Text · nothing to read`;
    b.dataset.kind = 'text';
  }
}

function renderWarnings() {
  const ul = $('warnings');
  ul.replaceChildren();
  for (const w of state.parsed?.warnings ?? []) {
    const li = document.createElement('li');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/vendor/icons.svg?v=4#i-alert-circle');
    icon.append(use);
    const span = document.createElement('span');
    span.textContent = w;
    li.append(icon, span);
    ul.append(li);
  }
}

/* -------------------------------------------------------------- mapping */

const mapSelects = {
  number: /** @type {HTMLSelectElement} */ ($('map-number')),
  question: /** @type {HTMLSelectElement} */ ($('map-question')),
  answer: /** @type {HTMLSelectElement} */ ($('map-answer')),
};

/** @param {string[]} headers */
function columnLabel(headers, /** @type {number} */ i) {
  const h = headers[i] ?? '';
  return h.length > 28 ? `${h.slice(0, 27)}…` : h;
}

/**
 * One-line summary on the collapsed Columns sheet, so the mapping can be checked
 * without opening it. Flags the sheet when Question or Answer is missing.
 */
function renderMappingSummary() {
  const p = state.parsed;
  const out = $('mapping-summary');
  const sheet = $('mapping-sheet');
  if (!p || p.kind !== 'table') return;
  const m = p.mapping;
  const playable = isMappingPlayable(m);
  sheet.classList.toggle('needs-attention', !playable);
  out.replaceChildren();
  if (!playable) {
    out.textContent = 'Choose the Question and Answer columns';
    return;
  }
  /** @param {string} tag @param {string} text */
  const pill = (tag, text) => {
    const span = document.createElement('span');
    span.className = 'pill';
    const b = document.createElement('b');
    b.textContent = tag;
    span.append(b, document.createTextNode(text));
    span.title = `${tag}: ${text}`;
    return span;
  };
  out.append(
    pill('Q', columnLabel(p.headers, /** @type {number} */ (m.question))),
    pill('A', columnLabel(p.headers, /** @type {number} */ (m.answer))),
  );
  const opts = Array.isArray(m.options) ? m.options.length : m.options ? 1 : 0;
  if (opts) out.append(pill('Opt', Array.isArray(m.options) ? `${opts} columns` : 'one cell'));
}

function renderMapping() {
  const p = state.parsed;
  const isTable = p?.kind === 'table' && p.headers.length > 0;
  $('mapping-sheet').classList.toggle('hidden', !isTable);
  renderMappingSummary();
  /** @type {HTMLInputElement} */ ($('has-header')).checked = settings.hasHeader;
  const hr = /** @type {HTMLInputElement} */ ($('header-row'));
  hr.value = String(settings.headerRow);
  hr.disabled = !settings.hasHeader;
  if (!isTable || p?.kind !== 'table') return;

  for (const role of /** @type {const} */ (['number', 'question', 'answer'])) {
    const sel = mapSelects[role];
    sel.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = role === 'number' ? 'None (use row order)' : 'Choose a column';
    sel.append(none);
    p.headers.forEach((_h, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${i + 1}. ${columnLabel(p.headers, i)}`;
      sel.append(o);
    });
    const v = p.mapping[role];
    sel.value = v === null ? '' : String(v);
    sel.setAttribute('aria-invalid', String(role !== 'number' && v === null));
  }

  const box = $('map-options');
  box.replaceChildren();
  const m = p.mapping;
  const taken = new Set([m.number, m.question, m.answer]);
  const chosen = new Set(
    Array.isArray(m.options) ? m.options.map((o) => o.col) : m.options ? [m.options.combinedCol] : [],
  );
  let any = false;
  p.headers.forEach((_h, i) => {
    if (taken.has(i)) return;
    any = true;
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(i);
    cb.checked = chosen.has(i);
    const span = document.createElement('span');
    span.textContent = columnLabel(p.headers, i);
    label.append(cb, span);
    box.append(label);
  });
  if (!any) {
    const s = document.createElement('span');
    s.className = 'muted';
    s.textContent = 'No other columns';
    box.append(s);
  }
}

/** Read the mapping panel back into the parsed result. */
/** @param {import('/shared/mapping.js').ColumnMapping} mapping */
function persistMapping(mapping) {
  if (settings.keepSession && session.contentId) sessionSet('mapping', { contentId: session.contentId, mapping });
}

function readMapping() {
  const p = state.parsed;
  if (!p || p.kind !== 'table') return;
  const val = (/** @type {HTMLSelectElement} */ s) => (s.value === '' ? null : Number(s.value));
  const number = val(mapSelects.number);
  const question = val(mapSelects.question);
  const answer = val(mapSelects.answer);
  const cols = [...$('map-options').querySelectorAll('input:checked')]
    .map((c) => Number(/** @type {HTMLInputElement} */ (c).value))
    .filter((c) => c !== number && c !== question && c !== answer)
    .sort((a, b) => a - b);
  const letters = /** @type {const} */ (['A', 'B', 'C', 'D', 'E']);
  /** @type {import('/shared/mapping.js').OptionsMapping} */
  const options =
    cols.length === 1 ? { combinedCol: cols[0] } : cols.slice(0, 5).map((col, i) => ({ letter: letters[i], col }));
  p.mapping = { number, question, answer, options };
  // The user has now chosen the columns, so mapping guesses and gaps are re-evaluated.
  p.warnings = p.warnings.filter((w) => !/^No (Question|Answer) column|^Some columns were guessed/.test(w));
  if (question === null) p.warnings.push('No Question column found. Pick one in the column mapping.');
  if (answer === null) p.warnings.push('No Answer column found. Pick one in the column mapping.');
  buildItems();
  renderWarnings();
  renderMapping();
  view.showTable(p, state.scripts);
  view.showScripts(settings.showScript);
  player.setItems(state.items, { keepPosition: true });
  view.setCurrent(player.index, { scroll: false });
  persistMapping(p.mapping);
  updateProgress();
}

for (const sel of Object.values(mapSelects)) sel.addEventListener('change', readMapping);
$('map-options').addEventListener('change', readMapping);
$('has-header').addEventListener('change', (e) => {
  settings.hasHeader = /** @type {HTMLInputElement} */ (e.target).checked;
  saveSettings();
  reparse({ keepSheet: true });
});
$('header-row').addEventListener('change', (e) => {
  const n = Math.round(Number(/** @type {HTMLInputElement} */ (e.target).value));
  settings.headerRow = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 1;
  saveSettings();
  reparse({ keepSheet: true });
});

/* ------------------------------------------------------------- progress */

function playableReason() {
  if (state.model === 'offline') return 'Cannot reach the ReadAloud server. Is it still running?';
  if (state.model === 'error') return 'The voice model failed to load. Use Retry at the top.';
  if (!state.ready) return 'The voice model is loading. Play will be available in a moment.';
  const p = state.parsed;
  if (state.book && !state.book.segments.length) return 'This PDF has no text to read.';
  if (p?.kind === 'table' && !p.headers.length) return 'No columns found. Set Mode to Auto or Plain text.';
  if (!p || !state.items.length) return 'Paste text or a table to start.';
  if (p.kind === 'table' && !isMappingPlayable(p.mapping)) return 'Choose the Question and Answer columns to play.';
  if (!state.items.some((it) => !it.skipped)) return 'There is nothing to read in this table.';
  return '';
}

function updateProgress() {
  const reason = playableReason();
  const blocked = Boolean(reason);
  for (const id of ['btn-play', 'btn-prev', 'btn-next', 'btn-repeat', 'btn-stop']) {
    /** @type {HTMLButtonElement} */ ($(id)).disabled = blocked;
  }
  /** @type {HTMLButtonElement} */ ($('open-export')).disabled = blocked;
  $('open-export').title = blocked ? reason : 'Export the whole reading to an audio file';

  const p = state.parsed;
  const bk = state.book;
  const total = bk ? bk.pageStarts.length : state.items.length;
  const unit = bk ? 'Page' : p?.kind === 'text' ? 'Sentence' : 'Row';
  const out = $('progress-text');
  const hint = $('play-hint');
  hint.classList.toggle('error', Boolean(state.lastError) && !blocked);

  // The position readout doubles as the "start from" input (FR-25).
  $('jump-form').classList.toggle('hidden', !total);
  $('pos-unit').textContent = unit;
  $('jump-label').textContent = `Start from ${unit.toLowerCase()}`;
  $('pos-total').textContent = `of ${total}`;
  const n = bk
    ? pageAt(bk.pageStarts, bk.segments[player.index]?.start ?? 0) + 1
    : total
      ? Math.min(player.index + 1, total)
      : 0;
  if (document.activeElement !== jumpIn) jumpIn.value = String(n || 1);
  jumpIn.style.setProperty('--digits', String(Math.max(2, String(total).length)));
  const fill = $('player-progress-fill');
  fill.style.transform = `scaleX(${total && player.state !== 'stopped' ? n / total : 0})`;

  if (blocked) {
    out.textContent = total ? `${total} ${unit.toLowerCase()}${total === 1 ? '' : 's'}` : 'Ready';
    hint.textContent = reason;
    return;
  }
  const prefix = { playing: '', buffering: '', paused: 'Paused · ', stopped: '' }[player.state];
  out.textContent = `${prefix}${unit} ${n} of ${total}`;
  const line =
    p?.kind === 'table' ? (state.scripts[player.index]?.text ?? '') : (p?.segments[player.index]?.text ?? '');
  if (state.lastError) hint.textContent = state.lastError;
  else if (player.state === 'buffering') hint.textContent = 'Generating speech…';
  else if (player.state === 'stopped')
    hint.textContent =
      p?.kind === 'table' ? 'Click a row or press Space to start' : 'Click a sentence or press Space to start';
  else hint.textContent = player.state === 'paused' ? `Paused · ${line}` : line;
}

/** @param {number} i */
function updateMediaSession(i) {
  if (!('mediaSession' in navigator) || i < 0 || !window.MediaMetadata) return;
  if (state.book) {
    const sec = state.book.sections[sectionAt(state.book.sections, i)];
    navigator.mediaSession.metadata = new MediaMetadata({ title: sec?.title ?? '', artist: state.book.title });
    return;
  }
  const unit = state.parsed?.kind === 'text' ? 'Sentence' : 'Question';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${unit} ${i + 1} of ${state.items.length}`,
    artist: 'ReadAloud',
  });
}

if ('mediaSession' in navigator) {
  // Headphone and lock-screen buttons, for hands-free listening.
  const ms = navigator.mediaSession;
  const safe = (/** @type {MediaSessionAction} */ a, /** @type {() => void} */ fn) => {
    try {
      ms.setActionHandler(a, fn);
    } catch {
      /* action unsupported in this browser */
    }
  };
  safe('play', () => player.play());
  safe('pause', () => player.pause());
  safe('stop', () => player.stop());
  safe('nexttrack', () => player.next());
  safe('previoustrack', () => player.prev());
}

/* ------------------------------------------------------------ transport */

playBtn.addEventListener('click', () => {
  // Re-assert the volume each start: some browsers reset it when src changes.
  player.setVolume(settings.volume);
  player.toggle();
});
$('btn-stop').addEventListener('click', () => player.stop());
$('btn-next').addEventListener('click', () => player.next());
$('btn-prev').addEventListener('click', () => player.prev());
$('btn-repeat').addEventListener('click', () => player.repeat());
const loopBtn = $('btn-loop');
loopBtn.addEventListener('click', () => {
  settings.loop = !settings.loop;
  loopBtn.setAttribute('aria-pressed', String(settings.loop));
  player.setLoop(settings.loop);
  saveSettings();
});

$('jump-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (playableReason()) return;
  const n = Math.round(Number(jumpIn.value));
  const max = state.book ? state.book.pageStarts.length : state.items.length;
  if (!Number.isFinite(n) || n < 1 || n > max) {
    toast(`Enter a number from 1 to ${max}.`, { kind: 'error' });
    return;
  }
  revealNextPosition = true;
  if (state.book) player.play(segmentAt(state.book.segments, state.book.pageStarts[n - 1]));
  else player.play(n - 1);
});

tbody.addEventListener('click', (e) => {
  const tr = /** @type {HTMLElement} */ (e.target).closest('tr');
  if (!tr || playableReason()) return;
  const i = Number(tr.dataset.i);
  if (state.items[i]?.skipped) {
    toast('That row has no question, so it is skipped.');
    return;
  }
  player.play(i);
});
tbody.addEventListener('keydown', (e) => {
  const max = view.rows.length - 1;
  const cur = view.cursor < 0 ? Math.max(0, player.index) : view.cursor;
  /** @type {Record<string, number>} */
  const moves = { ArrowDown: cur + 1, ArrowUp: cur - 1, Home: 0, End: max, PageDown: cur + 10, PageUp: cur - 10 };
  if (e.key in moves) {
    e.preventDefault();
    view.setCursor(Math.max(0, Math.min(max, moves[e.key])));
  } else if (e.key === 'Enter' && !playableReason()) {
    e.preventDefault();
    player.play(view.cursor < 0 ? 0 : view.cursor);
  }
});
tbody.addEventListener('focus', () => {
  if (view.cursor < 0) view.setCursor(Math.max(0, player.index), false);
});
$('text-view').addEventListener('click', (e) => {
  const s = /** @type {HTMLElement} */ (e.target).closest('.s');
  if (!s || playableReason()) return;
  player.play(Number(/** @type {HTMLElement} */ (s).dataset.i));
});

/* Scrolling the text or table by hand stops the view following the reader. Input
   events, not 'scroll': the view's own follow scrolling fires 'scroll' too. A stray
   wheel tick does no harm, since following resumes while the spoken line stays on screen. */
const stopFollowing = () => {
  following = false;
};
$('view').addEventListener('wheel', stopFollowing, { passive: true });
$('view').addEventListener('touchmove', stopFollowing, { passive: true });
$('view').addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) stopFollowing();
});
// A press on the scroll container itself (not a sentence or row) is its scrollbar.
$('view').addEventListener('pointerdown', (e) => {
  if (e.target === $('text-view') || e.target === $('table-wrap')) stopFollowing();
});

/* Keyboard shortcuts (FR-35). Off while typing, and Space is left alone on
   controls that already use it (buttons, checkboxes, selects). */
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
  if (document.querySelector('dialog[open]')) return;
  if (playableReason()) return;
  const onControl = Boolean(t.closest('button, a, label, summary'));
  if (e.shiftKey && state.book && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    gotoSection(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  switch (e.key) {
    case ' ':
      if (onControl) return;
      e.preventDefault();
      player.toggle();
      break;
    case 'ArrowRight':
      e.preventDefault();
      player.next();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      player.prev();
      break;
    case 'r':
    case 'R':
      player.repeat();
      break;
    case 'Escape':
      player.stop();
      break;
    default:
  }
});

/* --------------------------------------------------------- voice & speed */

function currentVoice() {
  return { voice: settings.voice, speed: settings.speed };
}

voiceSel.addEventListener('change', () => {
  settings.voice = voiceSel.value;
  saveSettings();
  player.setVoice(currentVoice());
});

let speedTimer = 0;
speedIn.addEventListener('input', () => {
  settings.speed = Math.round(Number(speedIn.value) * 100) / 100;
  $('speed-out').textContent = `${settings.speed.toFixed(2)}×`;
  saveSettings();
  // Debounced: dragging the slider should not fire a request per pixel.
  clearTimeout(speedTimer);
  speedTimer = window.setTimeout(() => player.setVoice(currentVoice()), 300);
});
volumeIn.addEventListener('input', () => {
  settings.volume = Number(volumeIn.value);
  $('volume-out').textContent = `${Math.round(settings.volume * 100)}%`;
  player.setVolume(settings.volume);
  saveSettings();
});

/** @param {{id:string, name:string, language:string, gender:string, grade:string}[]} voices */
function renderVoices(voices) {
  voiceSel.replaceChildren();
  /** @type {Record<string, string>} */
  const langNames = { 'en-us': 'American English', 'en-gb': 'British English' };
  const groups = new Map();
  for (const v of voices) {
    if (!groups.has(v.language)) {
      const g = document.createElement('optgroup');
      g.label = langNames[v.language] ?? v.language;
      groups.set(v.language, g);
      voiceSel.append(g);
    }
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = `${v.name} (${v.gender.toLowerCase()})`;
    groups.get(v.language).append(o);
  }
  if (!voices.some((v) => v.id === settings.voice)) settings.voice = voices[0]?.id ?? 'af_heart';
  voiceSel.value = settings.voice;
  player.setVoice(currentVoice());
}

/* ------------------------------------------------------------ health */

let healthTimer = 0;
async function pollHealth() {
  clearTimeout(healthTimer);
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const h = await res.json();
    const wasOffline = state.model === 'offline';
    state.ready = h.ready;
    state.mp3 = h.mp3;
    state.model = h.state === 'ready' ? 'ready' : h.state === 'error' ? 'error' : 'loading';
    if (wasOffline) player.clearCache();
    if (!voiceSel.options.length) {
      const voices = await (await fetch('/api/voices')).json();
      renderVoices(voices);
    }
    renderHealth(h);
    if (!h.ready) healthTimer = window.setTimeout(pollHealth, h.state === 'error' ? 5000 : 1000);
    else healthTimer = window.setTimeout(pollHealth, 15000);
  } catch {
    state.ready = false;
    state.model = 'offline';
    renderHealth(null);
    healthTimer = window.setTimeout(pollHealth, 3000);
  }
  updateProgress();
}

/** @param {any} h */
function renderHealth(h) {
  const box = $('model-status');
  const text = $('model-status-text');
  box.dataset.state = state.model;
  $('model-retry').classList.toggle('hidden', state.model !== 'error');
  if (state.model === 'offline') text.textContent = 'Server not reachable';
  else if (state.model === 'error') text.textContent = h?.error ?? 'Voice model failed to load';
  else if (state.model === 'ready') text.textContent = 'Voice ready';
  else if (h?.progress && h.progress.progress < 100)
    text.textContent = `Downloading voice model ${h.progress.progress}% (first run only)`;
  else text.textContent = 'Loading voice model…';
  box.title = state.model === 'ready' ? `Kokoro-82M (${h.dtype}) is loaded and works offline` : '';
}

$('model-retry').addEventListener('click', async () => {
  try {
    await fetch('/api/model/retry', { method: 'POST' });
  } catch {
    /* health polling reports the outcome */
  }
  state.model = 'loading';
  renderHealth(null);
  pollHealth();
});

/* ------------------------------------------------------------- input */

let typingTimer = 0;
let lastPastedText = '';

input.addEventListener('paste', (e) => {
  const html = e.clipboardData?.getData('text/html') ?? '';
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (html && hasHtmlTable(html)) {
    // A rich table paste replaces the input wholesale; keep the HTML for best fidelity.
    e.preventDefault();
    input.value = text;
    lastPastedText = text;
    state.raw = { text, html };
    reparse();
    return;
  }
  // Plain paste: let the textarea insert it, then parse right away.
  setTimeout(() => {
    state.raw = { text: input.value, html: '' };
    lastPastedText = input.value;
    reparse();
  }, 0);
});

input.addEventListener('input', () => {
  if (input.value === lastPastedText) return;
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => {
    // Typed edits invalidate the clipboard HTML (it no longer matches the text).
    state.raw = { text: input.value, html: '' };
    reparse();
  }, 300);
});

$('clear-input').addEventListener('click', () => {
  if (state.book || state.bookLoad) {
    closeBook();
    return;
  }
  input.value = '';
  lastPastedText = '';
  state.raw = { text: '', html: '' };
  reparse();
  input.focus();
});

const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** @param {File} file */
async function loadFile(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    openBook(file);
    return;
  }
  if (!/\.(txt|csv|tsv|md|markdown|text)$/i.test(file.name)) {
    toast('Use a .pdf, .txt, .csv, .tsv or .md file.', { kind: 'error' });
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    toast('That file is larger than 10 MB.', { kind: 'error' });
    return;
  }
  try {
    const text = await file.text();
    input.value = text;
    lastPastedText = text;
    state.raw = { text, html: '' };
    state.book = null;
    reparse();
    toast(`Loaded ${file.name}`);
  } catch {
    toast('Could not read that file.', { kind: 'error' });
  }
}

$('file-input').addEventListener('change', (e) => {
  const f = /** @type {HTMLInputElement} */ (e.target).files?.[0];
  if (f) loadFile(f);
  /** @type {HTMLInputElement} */ (e.target).value = '';
});

const drop = $('drop-zone');
let dragDepth = 0;
drop.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  drop.classList.add('dragging');
});
drop.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
drop.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.classList.remove('dragging');
});
drop.addEventListener('drop', (e) => {
  dragDepth = 0;
  drop.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  loadFile(f);
});

/* Session: keep what was loaded and where the reader was, across refreshes. Stored in
   this browser's IndexedDB only (session.js). Content is written when it changes, not
   on every re-parse; the position is written as reading moves. */
const keepCb = /** @type {HTMLInputElement} */ ($('remember-paste'));
const session = {
  /** The raw/book object last written, to skip rewriting unchanged (possibly huge) content. */
  /** @type {object | null} */
  ref: null,
  /** Id of the stored content; a saved position only applies to the content it came from. */
  contentId: '',
  posTimer: 0,
  /** @type {number} */
  pendingIndex: -1,
};

function persistContent() {
  if (!settings.keepSession) return;
  const ref = state.book ?? state.raw;
  if (ref === session.ref) return;
  session.ref = ref;
  const hasRaw = Boolean(state.raw.text.trim() || state.raw.html);
  if (!state.book && !hasRaw) {
    session.contentId = '';
    sessionDelete(['content', 'position', 'mapping']);
    return;
  }
  session.contentId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const content = state.book ? { kind: 'book', book: serializeBook(state.book) } : { kind: 'raw', raw: state.raw };
  sessionSet('content', { id: session.contentId, ...content });
  sessionDelete(['mapping', 'position']);
}

/** @param {number} i */
function persistPosition(i) {
  if (!settings.keepSession || !session.contentId || i < 0) return;
  session.pendingIndex = i;
  clearTimeout(session.posTimer);
  session.posTimer = window.setTimeout(flushPosition, 400);
}
function flushPosition() {
  clearTimeout(session.posTimer);
  if (session.pendingIndex < 0 || !session.contentId) return;
  sessionSet('position', { contentId: session.contentId, index: session.pendingIndex });
  session.pendingIndex = -1;
}
// Save the last move before the tab goes away (refresh, close, switch apps on a phone).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPosition();
});
window.addEventListener('pagehide', flushPosition);

keepCb.addEventListener('change', () => {
  settings.keepSession = keepCb.checked;
  saveSettings();
  session.ref = null;
  if (settings.keepSession) {
    persistContent();
    persistPosition(player.index);
  } else {
    session.contentId = '';
    sessionDelete(['content', 'position', 'mapping']);
  }
});

/**
 * Restore the last session: content first, then the user's column mapping, then the
 * reading position (paused there, scrolled into view; Play continues).
 */
async function restoreSession() {
  if (!settings.keepSession) return false;
  // Read everything before rendering: rendering queues a "position 0" save, which must
  // not be able to overwrite the stored position before it has been read.
  const [content, saved, pos] = await Promise.all([
    sessionGet('content'),
    sessionGet('mapping'),
    sessionGet('position'),
  ]);
  if (!content || typeof content.id !== 'string') return false;
  if (content.kind === 'book') {
    const book = restoreBook(content.book);
    if (!book) return false;
    state.book = book;
    session.ref = book;
    renderContents();
  } else if (content.kind === 'raw' && typeof content.raw?.text === 'string') {
    state.raw = { text: content.raw.text, html: typeof content.raw.html === 'string' ? content.raw.html : '' };
    input.value = state.raw.text;
    lastPastedText = state.raw.text;
    session.ref = state.raw;
  } else return false;
  session.contentId = content.id;
  reparse();

  const p = state.parsed;
  if (p?.kind === 'table' && saved?.contentId === content.id && validMapping(saved.mapping, p.headers.length)) {
    p.mapping = saved.mapping;
    buildItems();
    render();
    player.setItems(state.items);
  }

  const index = pos?.contentId === content.id ? Number(pos.index) : 0;
  if (Number.isInteger(index) && index > 0 && index < state.items.length) {
    revealNextPosition = true;
    player.seek(index);
    const where = state.book
      ? `page ${pageAt(state.book.pageStarts, state.book.segments[index]?.start ?? 0) + 1}`
      : `${p?.kind === 'table' ? 'row' : 'sentence'} ${index + 1}`;
    toast(`Picked up where you left off: ${where}. Press Play to continue.`, { ms: 6000 });
  }
  return true;
}

/**
 * A stored mapping is applied only if every column it names exists.
 * @param {any} m
 * @param {number} width
 */
function validMapping(m, width) {
  const ok = (/** @type {unknown} */ v) => v === null || (Number.isInteger(v) && /** @type {number} */ (v) < width);
  if (!m || !ok(m.number) || !ok(m.question) || !ok(m.answer)) return false;
  if (Array.isArray(m.options))
    return m.options.every((/** @type {any} */ o) => o && ok(o.col) && /^[A-E]$/.test(o.letter));
  return m.options && ok(m.options.combinedCol);
}

/* Mode selector (FR-3) */
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', (e) => {
    settings.mode = /** @type {any} */ (/** @type {HTMLInputElement} */ (e.target).value);
    saveSettings();
    reparse();
  });
}

$('show-script').addEventListener('change', (e) => {
  settings.showScript = /** @type {HTMLInputElement} */ (e.target).checked;
  view.showScripts(settings.showScript);
  saveSettings();
});

/* ------------------------------------------------------------ settings UI */

const tplIn = /** @type {HTMLTextAreaElement} */ ($('template'));
const num = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id));

function fillSettingsForm() {
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === settings.theme;
  }
  tplIn.value = settings.template;
  /** @type {HTMLInputElement} */ ($('read-options')).checked = settings.readOptions;
  for (const r of document.querySelectorAll('input[name="answer-style"]')) {
    /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === settings.answerStyle;
  }
  num('missing-answer').value = settings.missingAnswerText;
  num('pause-row').value = String(settings.rowPauseMs / 1000);
  num('pause-answer').value = String(settings.preAnswerPauseMs / 1000);
  num('pause-sentence').value = String(settings.sentencePauseMs / 1000);
  num('pause-paragraph').value = String(settings.paragraphPauseMs / 1000);
  num('pause-quiz').value = String(settings.quizPauseMs / 1000);
  /** @type {HTMLInputElement} */ ($('quiz-mode')).checked = settings.quizMode;
  num('pause-quiz').disabled = !settings.quizMode;
  /** @type {HTMLTextAreaElement} */ ($('pronunciations')).value = settings.pronunciations;
  validateTemplate();
}

function validateTemplate() {
  const bad = unknownPlaceholders(tplIn.value);
  const err = $('template-error');
  err.classList.toggle('hidden', bad.length === 0);
  err.textContent = bad.length
    ? `Unknown placeholder: ${bad.map((b) => `{${b}}`).join(', ')}. It will be read as nothing.`
    : '';
  tplIn.setAttribute('aria-invalid', String(bad.length > 0));
}

let rescriptTimer = 0;
function rescriptSoon() {
  clearTimeout(rescriptTimer);
  rescriptTimer = window.setTimeout(rescript, 250);
}

tplIn.addEventListener('input', () => {
  settings.template = tplIn.value;
  validateTemplate();
  saveSettings();
  rescriptSoon();
});
$('template-reset').addEventListener('click', () => {
  settings.template = DEFAULT_TEMPLATE;
  tplIn.value = DEFAULT_TEMPLATE;
  validateTemplate();
  saveSettings();
  rescript();
});
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.addEventListener('change', (e) => {
    settings.theme = /** @type {any} */ (/** @type {HTMLInputElement} */ (e.target).value);
    window.readAloudTheme?.set(settings.theme);
    // Save now, not debounced: theme.js reads this on the next load before paint.
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable: the theme lasts for this session only */
    }
  });
}
$('read-options').addEventListener('change', (e) => {
  settings.readOptions = /** @type {HTMLInputElement} */ (e.target).checked;
  saveSettings();
  rescript();
});
for (const r of document.querySelectorAll('input[name="answer-style"]')) {
  r.addEventListener('change', (e) => {
    settings.answerStyle = /** @type {any} */ (/** @type {HTMLInputElement} */ (e.target).value);
    saveSettings();
    rescript();
  });
}
num('missing-answer').addEventListener('input', (e) => {
  settings.missingAnswerText = /** @type {HTMLInputElement} */ (e.target).value || DEFAULT_MISSING_ANSWER;
  saveSettings();
  rescriptSoon();
});

/**
 * Bind a seconds input to a millisecond setting, clamped to the input's range.
 * @param {string} id
 * @param {'rowPauseMs'|'preAnswerPauseMs'|'sentencePauseMs'|'paragraphPauseMs'|'quizPauseMs'} key
 */
function bindPause(id, key) {
  const el = num(id);
  el.addEventListener('change', () => {
    const v = Number(el.value);
    const max = Number(el.max);
    const s = Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : DEFAULTS[key] / 1000;
    el.value = String(s);
    settings[key] = Math.round(s * 1000);
    saveSettings();
    rescript();
  });
}
bindPause('pause-row', 'rowPauseMs');
bindPause('pause-answer', 'preAnswerPauseMs');
bindPause('pause-sentence', 'sentencePauseMs');
bindPause('pause-paragraph', 'paragraphPauseMs');
bindPause('pause-quiz', 'quizPauseMs');
$('quiz-mode').addEventListener('change', (e) => {
  settings.quizMode = /** @type {HTMLInputElement} */ (e.target).checked;
  num('pause-quiz').disabled = !settings.quizMode;
  saveSettings();
  rescript();
});
$('pronunciations').addEventListener('input', (e) => {
  settings.pronunciations = /** @type {HTMLTextAreaElement} */ (e.target).value.slice(0, 5000);
  saveSettings();
  rescriptSoon();
});

$('open-settings').addEventListener('click', () => {
  fillSettingsForm();
  settingsDlg.showModal();
});
/** Close a modal dialog when its backdrop is clicked. @param {HTMLDialogElement} d */
function closeOnBackdrop(d, /** @type {() => void} */ onClose = () => d.close()) {
  d.addEventListener('click', (e) => {
    if (e.target === d) onClose();
  });
}
closeOnBackdrop(settingsDlg);

/* --------------------------------------------------------------- export */

/**
 * Items an export covers: everything, or for a book only the current section
 * (a whole textbook would be hours of audio and exceed the export limits).
 */
function exportItems() {
  if (!state.book) return state.items;
  const secs = state.book.sections;
  const si = Math.max(0, state.bookSection);
  const from = secs[si]?.segment ?? 0;
  const to = secs[si + 1]?.segment ?? state.items.length;
  return state.items.slice(from, to);
}

/** Rough length estimate for the export summary, e.g. "about 40 s" or "about 12 min". */
function estimateLength() {
  let chars = 0;
  let pauses = 0;
  for (const it of exportItems()) {
    for (const s of it.segments) {
      chars += s.text.length;
      pauses += s.pauseAfterMs;
    }
  }
  // Kokoro speaks roughly 12 characters a second at 1× (measured on sample rows).
  const sec = chars / (12 * settings.speed) + pauses / 1000;
  return sec < 90 ? `about ${Math.max(5, Math.round(sec / 5) * 5)} s` : `about ${Math.round(sec / 60)} min`;
}

function showExportPanel(/** @type {'setup'|'run'|'done'} */ which) {
  $('export-setup').classList.toggle('hidden', which !== 'setup');
  $('export-run').classList.toggle('hidden', which !== 'run');
  $('export-done').classList.toggle('hidden', which !== 'done');
}

$('open-export').addEventListener('click', () => {
  if (!state.exportId) {
    const n = exportItems().filter((i) => !i.skipped).length;
    const unit = state.parsed?.kind === 'text' ? 'sentence' : 'row';
    const what = state.book
      ? `This section, "${state.book.sections[Math.max(0, state.bookSection)]?.title ?? ''}": ${n} ${unit}${n === 1 ? '' : 's'}`
      : `${n} ${unit}${n === 1 ? '' : 's'}`;
    $('export-summary').textContent =
      `${what} with your current voice, speed and pauses: ${estimateLength()} of audio.`;
    const mp3 = exportDlg.querySelector('[data-format="mp3"]');
    mp3?.classList.toggle('hidden', !state.mp3);
    const zipLabel = exportDlg.querySelector('[data-format="zip"] span');
    if (zipLabel) zipLabel.textContent = `One WAV per ${unit}, zipped`;
    const checked = /** @type {HTMLInputElement|null} */ (
      exportDlg.querySelector('input[name="export-format"]:checked')
    );
    if (checked?.value === 'mp3' && !state.mp3)
      /** @type {HTMLInputElement} */ (exportDlg.querySelector('input[value="wav"]')).checked = true;
    showExportPanel('setup');
  }
  exportDlg.showModal();
});
$('export-close').addEventListener('click', () => exportDlg.close());
closeOnBackdrop(exportDlg);
exportDlg.addEventListener('close', () => {
  // Closing after a finished export resets it; a running one keeps going.
  if (!$('export-done').classList.contains('hidden')) resetExport();
});

function resetExport() {
  state.exportEvents?.close();
  state.exportEvents = null;
  state.exportId = null;
  showExportPanel('setup');
  /** @type {HTMLButtonElement} */ ($('export-start')).disabled = false;
}

/** @param {{id:string, status:string, done:number, total:number, error:string|null, format:string, durationSec:number}} job */
function onExportUpdate(job) {
  if (job.id !== state.exportId) return;
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const unit = state.parsed?.kind === 'text' ? 'sentences' : 'rows';
  $('export-progress-text').textContent = `Generating ${job.done} / ${job.total} ${unit}…`;
  $('export-bar-fill').style.transform = `scaleX(${pct / 100})`;
  $('export-bar').setAttribute('aria-valuenow', String(pct));
  if (job.status === 'done') {
    state.exportEvents?.close();
    state.exportEvents = null;
    const mins = Math.floor(job.durationSec / 60);
    const secs = job.durationSec % 60;
    $('export-done-text').textContent = `Ready: ${mins} min ${secs} s of audio.`;
    /** @type {HTMLAnchorElement} */ ($('export-download')).href = `/api/export/${encodeURIComponent(job.id)}/file`;
    /** @type {HTMLAnchorElement} */ ($('export-transcript')).href =
      `/api/export/${encodeURIComponent(job.id)}/transcript`;
    $('export-transcript').classList.toggle('hidden', job.format === 'zip');
    showExportPanel('done');
    if (!exportDlg.open) toast('Export ready. Open Export audio to download it.');
  } else if (job.status === 'error' || job.status === 'cancelled') {
    if (job.status === 'error') toast(job.error ?? 'Export failed.', { kind: 'error' });
    else toast('Export cancelled.');
    resetExport();
  }
}

function watchExport(/** @type {string} */ id) {
  const es = new EventSource(`/api/export/${encodeURIComponent(id)}/events`);
  state.exportEvents = es;
  es.onmessage = (e) => {
    try {
      onExportUpdate(JSON.parse(e.data));
    } catch {
      /* ignore malformed event */
    }
  };
  es.onerror = () => {
    // Connection dropped: fall back to polling until the job settles.
    es.close();
    if (state.exportEvents !== es) return;
    state.exportEvents = null;
    const poll = async () => {
      if (state.exportId !== id) return;
      try {
        const res = await fetch(`/api/export/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const job = await res.json();
        onExportUpdate(job);
        if (job.status === 'running') setTimeout(poll, 1000);
      } catch {
        toast('Lost contact with the export. Please try again.', { kind: 'error' });
        resetExport();
      }
    };
    setTimeout(poll, 1000);
  };
}

$('export-start').addEventListener('click', async () => {
  const fmt =
    /** @type {HTMLInputElement|null} */ (exportDlg.querySelector('input[name="export-format"]:checked'))?.value ??
    'wav';
  /** @type {{text:string, pauseAfterMs:number, group:number}[]} */
  const segments = [];
  let group = 0;
  for (const it of exportItems()) {
    if (it.skipped || !it.segments.length) continue;
    for (const s of it.segments) segments.push({ text: s.text, pauseAfterMs: s.pauseAfterMs, group });
    group++;
  }
  if (!segments.length) return;
  const startBtn = /** @type {HTMLButtonElement} */ ($('export-start'));
  startBtn.disabled = true;
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments,
        voice: settings.voice,
        speed: settings.speed,
        format: fmt,
        prefix: state.parsed?.kind === 'text' ? 'Part' : 'Q',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not start the export.');
    state.exportId = body.id;
    $('export-progress-text').textContent = 'Starting…';
    $('export-bar-fill').style.transform = 'scaleX(0)';
    showExportPanel('run');
    watchExport(body.id);
  } catch (err) {
    toast(/** @type {Error} */ (err).message, { kind: 'error' });
    startBtn.disabled = false;
  }
});

$('export-cancel').addEventListener('click', async () => {
  const id = state.exportId;
  if (!id) return;
  /** @type {HTMLButtonElement} */ ($('export-cancel')).disabled = true;
  try {
    await fetch(`/api/export/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* the event stream reports the final state */
  }
  /** @type {HTMLButtonElement} */ ($('export-cancel')).disabled = false;
});

/* ------------------------------------------------------------------ boot */

/* ----------------------------------------------------------------- book */

/**
 * Make sure the section containing segment `i` is the one rendered.
 * @param {number} i
 */
function ensureBookSection(i) {
  const bk = state.book;
  if (!bk || !bk.sections.length) return;
  const si = sectionAt(bk.sections, i);
  if (si === state.bookSection && i >= view.range.from && i < view.range.to) return;
  state.bookSection = si;
  const sec = bk.sections[si];
  const to = bk.sections[si + 1]?.segment ?? bk.segments.length;
  view.showText(/** @type {any} */ (state.parsed), { from: sec.segment, to, heading: sec.title });
  renderBookHead();
  markContents();
}

/** Move to the next (+1) or previous (-1) section, keeping play/pause state. */
function gotoSection(/** @type {number} */ dir) {
  const bk = state.book;
  if (!bk || !bk.sections.length) return;
  const si = Math.min(bk.sections.length - 1, Math.max(0, state.bookSection + dir));
  if (si === state.bookSection && dir !== 0) return;
  revealNextPosition = true;
  player.seek(bk.sections[si].segment);
}

function renderBookHead() {
  const bk = state.book;
  const head = $('book-head');
  head.classList.toggle('hidden', !bk || !bk.sections.length);
  if (!bk || !bk.sections.length) return;
  const si = Math.max(0, state.bookSection);
  const sec = bk.sections[si];
  $('book-section-title').textContent = sec.title;
  $('book-section-meta').textContent = `Section ${si + 1} of ${bk.sections.length} · page ${sec.page + 1}`;
  /** @type {HTMLButtonElement} */ ($('section-prev')).disabled = si === 0;
  /** @type {HTMLButtonElement} */ ($('section-next')).disabled = si >= bk.sections.length - 1;
}

/** Build the Contents list from the book's outline (its "legend"). */
function renderContents() {
  const list = $('contents-list');
  list.replaceChildren();
  const bk = state.book;
  if (!bk) return;
  const frag = document.createDocumentFragment();
  bk.sections.forEach((sec, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `toc-item depth-${sec.depth}`;
    btn.dataset.s = String(i);
    const title = document.createElement('span');
    title.className = 'toc-title';
    title.textContent = sec.title;
    const pg = document.createElement('span');
    pg.className = 'toc-page';
    pg.textContent = String(sec.page + 1);
    btn.append(title, pg);
    btn.title = `${sec.title} (page ${sec.page + 1})`;
    li.append(btn);
    frag.append(li);
  });
  list.append(frag);
  $('contents-empty').classList.toggle('hidden', bk.sections.length > 0);
}

/** Highlight the current section in Contents and keep it in view. */
function markContents() {
  const list = $('contents-list');
  list.querySelector('[aria-current]')?.removeAttribute('aria-current');
  const btn = /** @type {HTMLElement|null} */ (list.querySelector(`[data-s="${state.bookSection}"]`));
  $('contents-current').textContent = state.book?.sections[state.bookSection]?.title ?? '';
  if (!btn) return;
  btn.setAttribute('aria-current', 'true');
  // Scroll the list itself, not the page: scrollIntoView would also move the whole page
  // on phones and tablets and pull the reader away from the text.
  const b = btn.getBoundingClientRect();
  const c = list.getBoundingClientRect();
  if (b.top < c.top) list.scrollTop -= c.top - b.top + 8;
  else if (b.bottom > c.bottom) list.scrollTop += b.bottom - c.bottom + 8;
}

/* Contents can be minimised to one line: "Contents · current section". */
function applyContents() {
  const collapsed = settings.contentsCollapsed;
  $('contents').classList.toggle('collapsed', collapsed);
  const btn = $('contents-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Show contents' : 'Hide contents';
}
$('contents-toggle').addEventListener('click', () => {
  settings.contentsCollapsed = !settings.contentsCollapsed;
  saveSettings();
  applyContents();
  if (!settings.contentsCollapsed) markContents(); // bring the current entry into view
});

function renderBook() {
  const bk = state.book;
  $('book').classList.toggle('hidden', !bk && !state.bookLoad);
  if (!bk) return;
  $('book-title').textContent = bk.title;
  $('book-meta').textContent = `${bk.pageStarts.length} pages · ${
    bk.fromOutline ? `${bk.sections.length} sections from the book's contents` : 'no contents found, grouped by pages'
  }`;
}

$('contents-list').addEventListener('click', (e) => {
  const btn = /** @type {HTMLElement} */ (e.target).closest('.toc-item');
  if (!btn || !state.book || playableReason()) return;
  revealNextPosition = true;
  player.play(state.book.sections[Number(/** @type {HTMLElement} */ (btn).dataset.s)].segment);
});
/* Click the spoken line in the player to jump back to it in the text or table. */
$('play-hint').addEventListener('click', () => {
  const i = player.index;
  if (!state.items.length || i < 0 || i >= state.items.length) return;
  if (state.book) ensureBookSection(i); // re-renders if the reader browsed to another section
  view.setCurrent(i, { scroll: false });
  view.revealCurrent();
  following = true;
});
$('section-prev').addEventListener('click', () => gotoSection(-1));
$('section-next').addEventListener('click', () => gotoSection(1));

/**
 * Open a PDF as a book. Parsing happens in the browser (pdf.js worker); the loader
 * is imported on first use so pdf.js costs nothing until a PDF is opened.
 * @param {File} file
 */
async function openBook(file) {
  state.bookLoad?.abort();
  const ac = new AbortController();
  state.bookLoad = ac;
  const previous = state.book;
  $('book').classList.remove('hidden');
  $('input-panel').classList.add('has-book');
  $('book-title').textContent = file.name;
  $('book-meta').textContent = 'Opening…';
  $('book-loading').classList.remove('hidden');
  $('contents').classList.add('hidden');
  $('book-loading-text').textContent = 'Opening the PDF…';
  $('book-bar').style.transform = 'scaleX(0)';
  try {
    const { loadPdf } = await import('./book-loader.js');
    const book = await loadPdf(file, {
      signal: ac.signal,
      onProgress: (done, total) => {
        $('book-loading-text').textContent = `Reading page ${done} of ${total}…`;
        $('book-bar').style.transform = `scaleX(${done / total})`;
      },
    });
    if (state.bookLoad !== ac) return;
    state.book = book;
    state.bookLoad = null;
    $('book-loading').classList.add('hidden');
    $('contents').classList.remove('hidden');
    renderContents();
    reparse();
    if (book.segments.length) toast(`Opened "${book.title}"`);
  } catch (err) {
    if (state.bookLoad !== ac) return;
    state.bookLoad = null;
    $('book-loading').classList.add('hidden');
    $('contents').classList.remove('hidden');
    state.book = previous;
    reparse();
    if (/** @type {Error} */ (err)?.name !== 'AbortError')
      toast(/** @type {Error} */ (err)?.message || 'Could not open that PDF.', { kind: 'error' });
  }
}

function closeBook() {
  state.bookLoad?.abort();
  state.bookLoad = null;
  state.book = null;
  state.bookSection = -1;
  $('book-loading').classList.add('hidden');
  $('contents').classList.remove('hidden');
  renderContents();
  $('book-head').classList.add('hidden');
  reparse();
}
$('book-close').addEventListener('click', closeBook);
$('book-cancel').addEventListener('click', () => {
  state.bookLoad?.abort();
});

/* Empty-state samples: let a first-time user hear the app before finding a file. */
const SAMPLE_TABLE = [
  ['No', 'Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Answer'],
  ['1', 'What is the capital of France?', 'Berlin', 'Paris', 'Madrid', 'Rome', 'B'],
  ['2', 'Which planet is known as the Red Planet?', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'B'],
  ['3', 'The ___ is the largest organ of the human body.', 'Heart', 'Skin', 'Liver', 'Lung', 'B'],
  ['4', 'Which gas do plants absorb during photosynthesis?', 'Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium', 'C'],
  ['5', 'Who wrote Romeo and Juliet?', 'William Shakespeare', 'Charles Dickens', 'Jane Austen', 'Mark Twain', 'A'],
]
  .map((r) => r.join('\t'))
  .join('\n');
const SAMPLE_TEXT =
  'Photosynthesis is how plants turn light into food. Inside the leaves, chlorophyll captures energy from sunlight.\n\n' +
  'The plant uses that energy to combine water and carbon dioxide into glucose. Oxygen is released as a by-product, which is the air we breathe.';

/** @param {string} text */
function loadSample(text) {
  state.book = null;
  input.value = text;
  lastPastedText = text;
  state.raw = { text, html: '' };
  reparse();
}
$('sample-table').addEventListener('click', () => loadSample(SAMPLE_TABLE));
$('sample-text').addEventListener('click', () => loadSample(SAMPLE_TEXT));

/* Collapsible player tray: a slim mini-player (position, spoken line, Play) or the
   full controls. Keyboard shortcuts work either way. */
function applyTray() {
  const collapsed = settings.trayCollapsed;
  $('player').classList.toggle('collapsed', collapsed);
  const btn = $('tray-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show player controls' : 'Hide player controls';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}
$('tray-toggle').addEventListener('click', () => {
  settings.trayCollapsed = !settings.trayCollapsed;
  saveSettings();
  applyTray();
});

async function boot() {
  applyTray();
  applyContents();
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === settings.mode;
  }
  speedIn.value = String(settings.speed);
  $('speed-out').textContent = `${settings.speed.toFixed(2)}×`;
  volumeIn.value = String(settings.volume);
  $('volume-out').textContent = `${Math.round(settings.volume * 100)}%`;
  player.setVolume(settings.volume);
  loopBtn.setAttribute('aria-pressed', String(settings.loop));
  player.setLoop(settings.loop);
  /** @type {HTMLInputElement} */ ($('show-script')).checked = settings.showScript;
  keepCb.checked = settings.keepSession;
  try {
    localStorage.removeItem(PASTE_KEY); // superseded by the IndexedDB session
  } catch {
    /* storage unavailable */
  }
  pollHealth();
  if (!(await restoreSession())) reparse();
}

boot();
