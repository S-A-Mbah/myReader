/**
 * ReadAloud server: static UI + JSON API, bound to loopback only.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig, HOST, ROOT } from './config.js';
import { TtsEngine, SAMPLE_RATE } from './tts.js';
import { encodeWav, MP3_AVAILABLE } from './audio.js';
import { ExportManager } from './export.js';

const require = createRequire(import.meta.url);
const config = loadConfig();
const engine = new TtsEngine(config);
const exports_ = new ExportManager(engine);

/* ------------------------------------------------------------------ assets */

/** papaparse ships UMD only; wrap it as an ES module for the browser. */
function papaparseModule() {
  const src = readFileSync(require.resolve('papaparse/papaparse.min.js'), 'utf8');
  return `const module = { exports: {} }; const exports = module.exports;\n${src}\nexport default module.exports;\n`;
}

/** Build one SVG sprite from the Tabler icons the UI uses (no hand-drawn icons). */
function iconSprite() {
  const outline = [
    'player-skip-back',
    'player-skip-forward',
    'repeat',
    'rotate',
    'chevron-up',
    'adjustments-horizontal',
    'book',
    'chevron-left',
    'chevron-right',
    'volume',
    'volume-off',
    'settings',
    'download',
    'upload',
    'x',
    'alert-circle',
    'check',
    'loader-2',
    'table',
    'align-left',
    'keyboard',
    'refresh',
    'file-text',
    'chevron-down',
    'clipboard',
  ];
  const filled = ['player-play', 'player-pause', 'player-stop'];
  const read = (/** @type {string} */ kind, /** @type {string} */ name) => {
    // The package exports "./*" → "./icons/*".
    const svg = readFileSync(require.resolve(`@tabler/icons/${kind}/${name}.svg`), 'utf8');
    return svg
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/, '')
      .trim();
  };
  const symbols = [
    ...outline.map(
      (n) =>
        `<symbol id="i-${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${read('outline', n)}</symbol>`,
    ),
    ...filled.map((n) => `<symbol id="i-${n}" viewBox="0 0 24 24" fill="currentColor">${read('filled', n)}</symbol>`),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
}

const PAPA_JS = papaparseModule();
const ICONS_SVG = iconSprite();
const FONT_FILES = {
  'geist.woff2': require.resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'),
  'geist-ext.woff2': require.resolve('@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2'),
  'geist-mono.woff2': require.resolve('@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2'),
};

/* -------------------------------------------------------------------- app */

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');

const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

// DNS-rebinding defence: a hostile page can resolve its own domain to 127.0.0.1,
// so only accept requests addressed to a loopback host name.
app.use((req, res, next) => {
  if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
    res.status(403).type('text/plain').send('Forbidden host');
    return;
  }
  // CSRF defence: state-changing requests must come from our own pages.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: 'Cross-origin request blocked.' });
    return;
  }
  next();
});

// Security headers. Everything is same-origin; no inline script is ever needed.
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.get('/shared/papa.js', (_req, res) => {
  res.type('text/javascript').set('Cache-Control', 'no-cache').send(PAPA_JS);
});
app.get('/vendor/icons.svg', (_req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(ICONS_SVG);
});
app.get('/fonts/:name', (req, res, next) => {
  // Only names from a fixed allowlist map to files: no user-controlled paths.
  const file = Object.hasOwn(FONT_FILES, req.params.name)
    ? FONT_FILES[/** @type {keyof typeof FONT_FILES} */ (req.params.name)]
    : null;
  if (!file) return next();
  res.type('font/woff2').set('Cache-Control', 'public, max-age=604800, immutable').sendFile(file);
});
app.use('/shared', express.static(path.join(ROOT, 'src', 'shared'), { index: false, dotfiles: 'deny' }));

// pdf.js for reading PDF books in the browser. Only these two scripts and the two
// read-only data folders are exposed; nothing else in node_modules is reachable.
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_FILES = {
  'pdf.min.mjs': path.join(PDFJS_DIR, 'build', 'pdf.min.mjs'),
  'pdf.worker.min.mjs': path.join(PDFJS_DIR, 'build', 'pdf.worker.min.mjs'),
};
app.get('/vendor/pdfjs/:name', (req, res, next) => {
  const file = Object.hasOwn(PDFJS_FILES, req.params.name)
    ? PDFJS_FILES[/** @type {keyof typeof PDFJS_FILES} */ (req.params.name)]
    : null;
  if (!file) return next();
  res.type('text/javascript').set('Cache-Control', 'no-cache').sendFile(file);
});
for (const dir of ['cmaps', 'standard_fonts']) {
  app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(PDFJS_DIR, dir), { index: false, dotfiles: 'deny' }));
}
app.use(express.static(path.join(ROOT, 'public'), { dotfiles: 'deny' }));

/* -------------------------------------------------------------------- api */

const MAX_TTS_CHARS = 2000;
const MAX_EXPORT_SEGMENTS = 20000;
const MAX_EXPORT_CHARS = 1_500_000;

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} v */
function checkSpeed(v) {
  const n = Number(v ?? 1);
  if (!Number.isFinite(n) || n < 0.5 || n > 2) throw new HttpError(400, 'Speed must be between 0.5 and 2.');
  return Math.round(n * 100) / 100;
}

/** @param {unknown} v */
function checkVoice(v) {
  if (!engine.hasVoice(v)) throw new HttpError(400, 'Unknown voice.');
  return /** @type {string} */ (v);
}

/** @param {unknown} v @param {number} max */
function checkPause(v, max) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `Pause must be between 0 and ${max} ms.`);
  return Math.round(n);
}

function requireReady() {
  if (engine.state !== 'ready') throw new HttpError(503, 'The voice model is still loading.');
}

const api = express.Router();
const smallJson = express.json({ limit: '64kb', strict: true });
const bigJson = express.json({ limit: '8mb', strict: true });

api.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ready: engine.state === 'ready',
    state: engine.state,
    model: config.model,
    dtype: config.dtype,
    device: 'cpu',
    progress: engine.progress,
    error: engine.error,
    defaultVoice: engine.defaultVoice(),
    formats: exports_.formats(),
    mp3: MP3_AVAILABLE,
  });
});

api.post('/model/retry', (_req, res) => {
  if (engine.state === 'error') engine.init();
  res.status(202).json({ state: engine.state });
});

api.get('/voices', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(engine.listVoices());
});

api.post('/tts', smallJson, async (req, res, next) => {
  const ac = new AbortController();
  // Client navigated away or skipped ahead: drop the job if it has not started.
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  try {
    requireReady();
    const body = req.body ?? {};
    if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'Text is required.');
    if (body.text.length > MAX_TTS_CHARS) throw new HttpError(400, `Text must be at most ${MAX_TTS_CHARS} characters.`);
    const voice = checkVoice(body.voice);
    const speed = checkSpeed(body.speed);
    const pause = checkPause(body.pauseAfterMs, 60000);
    // Prefetches queue behind whatever the listener is waiting for right now.
    const priority = body.prefetch === true ? 'normal' : 'high';
    const pcm = await engine.synthesize(body.text, voice, speed, { priority, signal: ac.signal });
    const wav = encodeWav(pcm, SAMPLE_RATE, pause);
    res
      .set('Cache-Control', 'no-store')
      .set('X-Speech-Ms', String(Math.round((pcm.length / SAMPLE_RATE) * 1000)))
      .type('audio/wav')
      .send(wav);
  } catch (err) {
    if (/** @type {Error} */ (err)?.name === 'AbortError') return; // client is gone
    next(err);
  }
});

api.post('/export', bigJson, (req, res) => {
  requireReady();
  if (exports_.running()) throw new HttpError(409, 'An export is already running. Cancel it or wait for it to finish.');
  const body = req.body ?? {};
  const voice = checkVoice(body.voice);
  const speed = checkSpeed(body.speed);
  const format = body.format ?? 'wav';
  if (!exports_.formats().includes(format)) throw new HttpError(400, 'Unsupported export format.');
  const prefix = body.prefix ?? 'Q';
  if (typeof prefix !== 'string' || !/^[A-Za-z]{1,8}$/.test(prefix)) throw new HttpError(400, 'Invalid file prefix.');
  if (!Array.isArray(body.segments) || body.segments.length === 0 || body.segments.length > MAX_EXPORT_SEGMENTS) {
    throw new HttpError(400, `Export needs between 1 and ${MAX_EXPORT_SEGMENTS} segments.`);
  }
  let chars = 0;
  let lastGroup = -1;
  const segments = body.segments.map((/** @type {any} */ s) => {
    if (!s || typeof s.text !== 'string' || s.text.length > MAX_TTS_CHARS)
      throw new HttpError(400, 'Invalid segment text.');
    const group = Number(s.group);
    if (!Number.isInteger(group) || group < lastGroup || group > MAX_EXPORT_SEGMENTS)
      throw new HttpError(400, 'Invalid segment group.');
    lastGroup = group;
    chars += s.text.length;
    return { text: s.text, pauseAfterMs: checkPause(s.pauseAfterMs, 60000), group };
  });
  if (chars > MAX_EXPORT_CHARS) throw new HttpError(400, 'Export is too large.');
  const job = exports_.create({ segments, voice, speed, format, prefix });
  res.status(202).json(exports_.view(job));
});

/** @param {string} id */
function getJob(id) {
  const job = exports_.get(id);
  if (!job) throw new HttpError(404, 'Export not found.');
  return job;
}

api.get('/export/:id', (req, res) => {
  res.set('Cache-Control', 'no-store').json(exports_.view(getJob(req.params.id)));
});

api.get('/export/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const send = (/** @type {import('./export.js').ExportJob} */ j) => {
    res.write(`data: ${JSON.stringify(exports_.view(j))}\n\n`);
    if (j.status !== 'running') res.end();
  };
  const unsubscribe = exports_.subscribe(job, send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
  send(job);
});

api.get('/export/:id/file', (req, res, next) => {
  const job = getJob(req.params.id);
  if (job.status !== 'done') throw new HttpError(409, 'Export is not finished.');
  const d = new Date(); // local time: the user reads this name in their downloads folder
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  res.type(exports_.contentType(job));
  res.download(job.filePath, `readaloud-${stamp}.${job.format}`, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

api.get('/export/:id/transcript', (req, res) => {
  const job = getJob(req.params.id);
  if (job.status !== 'done') throw new HttpError(409, 'Export is not finished.');
  if (job.format === 'zip') throw new HttpError(400, 'Transcripts are available for single-file exports.');
  res.attachment('readaloud-transcript.srt').type('application/x-subrip; charset=utf-8').send(job.transcript);
});

api.delete('/export/:id', (req, res) => {
  const job = getJob(req.params.id);
  exports_.cancel(job);
  res.json(exports_.view(job));
});

api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));

app.use('/api', api);

// One error handler: friendly JSON, never a stack trace or the user's text (privacy).
app.use(
  (
    /** @type {any} */ err,
    /** @type {express.Request} */ req,
    /** @type {express.Response} */ res,
    /** @type {express.NextFunction} */ _next,
  ) => {
    let status = err instanceof HttpError ? err.status : Number(err?.status ?? err?.statusCode) || 500;
    let message = err instanceof HttpError ? err.message : 'Something went wrong. Please try again.';
    if (err?.type === 'entity.parse.failed') message = 'The request was not valid JSON.';
    else if (err?.type === 'entity.too.large') message = 'The request is too large.';
    else if (status >= 500) console.error(`[server] ${req.method} ${req.path}:`, err?.message ?? err);
    if (status < 400 || status > 599) status = 500;
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ error: message });
  },
);

/* ------------------------------------------------------------------ start */

// http.createServer rather than app.listen: Express 5 also calls the listen
// callback on 'error', which would report success for a port that is taken.
const server = createServer(app);
server.listen(config.port, HOST, () => {
  console.log(
    HOST === '127.0.0.1'
      ? `ReadAloud running at http://localhost:${config.port}  (bound to ${HOST} only)`
      : `ReadAloud running on port ${config.port} inside the container. Publish it to 127.0.0.1 only.`,
  );
  engine.init();
});
server.on('error', (err) => {
  if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Close the other app or set PORT=xxxx and try again.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\nShutting down...');
  await exports_.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
