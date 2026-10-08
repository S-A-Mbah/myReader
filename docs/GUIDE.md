# ReadAloud: full guide

ReadAloud is a free, fully local app that reads pasted content aloud using the open-source
[Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) voice model.

- **Plain text:** reads articles and notes as written, highlighting each sentence as it is spoken.
- **Table (MCQ):** paste a question bank from Excel, Google Sheets, Word, a web page, CSV or Markdown, and
  it reads `Question 1. What is the capital of France? Answer, B, Paris.` for each row, skipping the options.

Everything runs on your computer. After the one-time model download, the app works offline. Nothing you
paste leaves the machine, and there are no accounts, API keys or costs.

## Requirements

- Node.js 20 or newer (`node -v` to check)
- About 1.5 GB of free disk space (dependencies plus the voice model)
- Internet access for the first run only

## Setup

### Windows

```powershell
cd path\to\readaloud
npm install
npm start
```

### macOS and Linux

```bash
cd path/to/readaloud
npm install
npm start
```

Then open <http://localhost:3000>.

The first start downloads the voice model (about 330 MB for the default `fp32` model) into `.cache/models`.
The header shows the progress. Later starts load the model from that folder without touching the network.

**Port already in use?** Start on another port:

```bash
PORT=3123 npm start
```

On Windows PowerShell: `$env:PORT=3123; npm start`

## Using it

1. Paste into the big box, drop a `.pdf`, `.txt`, `.csv`, `.tsv` or `.md` file on it, or use **Open file**.
2. The badge at the top shows what was detected, for example `Detected: Table · 7 columns · 120 rows`.
   Use **Auto / Plain text / Table (MCQ)** to override it.
3. For tables, check the **Column mapping**. Number, Question, Answer and Options are filled in
   automatically from the header row. Tick one options column for a combined cell such as
   `a) Berlin b) Paris`, or several for one option per column. Play stays disabled until a Question
   and an Answer column are chosen.
4. Press **Play**, click a row (or sentence) to start there, or type a row number in **Start from row**.

### Textbooks (PDF)

Open or drop a `.pdf` to listen to it like a book.

- **Contents** in the left panel comes from the PDF's own table of contents (its bookmarks/outline),
  with chapters and sub-sections indented. Click any entry to jump there and start reading. If a PDF
  has no outline, Contents lists the book in 10-page ranges instead.
- The bar above the text shows the current section, with buttons for the previous and next
  section (or **Shift+←** / **Shift+→**).
- The counter in the player shows the **page**; type a page number and press Enter to jump to it.
- Running headers, footers and page numbers are left out, and words split across lines with a hyphen
  are joined back together.
- **Export audio** exports the section you are in, not the whole book.
- PDFs are read inside your browser and never uploaded anywhere. Scanned PDFs (pictures of pages with
  no selectable text) cannot be read; OCR is not supported. Password-protected PDFs need the password
  removed first.

### Keyboard

| Key           | Action                                   |
| ------------- | ---------------------------------------- |
| Space         | Play or pause                            |
| → / ←         | Next or previous row (sentence)          |
| R             | Restart the current row from its start   |
| Shift + → / ← | Next or previous section of a PDF book   |
| Esc           | Stop                                     |
| ↑ ↓ and Enter | In the table: move, then play from a row |

Shortcuts are ignored while you are typing in a field. Headphone and lock-screen media keys also work.

### Settings

Open **Settings** to change:

- **Appearance:** `System` (default, follows your OS and switches live), `Light` or `Dark`.
- **Spoken template.** The default is `Question {number}. {question}. Answer, {answer}.` Placeholders:
  `{number}`, `{question}`, `{answer}`, `{answerLetter}`, `{answerText}`, `{optionA}`…`{optionE}`, `{options}`.
- **Also read options**, which reads `A, Berlin. B, Paris. …` before the answer.
- **Letter answers:** `Letter and text` (default, "Answer, B, Paris."), `Option text` ("Answer, Paris.")
  or `As written` ("Answer, B.").
- **Pauses** between rows (1.5 s), before the answer (0.8 s), between sentences and between paragraphs.
- **Quiz mode**, a longer pause before the answer (5 s) so you can answer first.
- **Pronunciation**, one rule per line, for example `e.g. = for example`.

Voice, speed, volume and settings are remembered in this browser.

### Picking up where you left off

Refreshing or reopening the page brings back what you had loaded (pasted text, a table with any column
mapping you changed, or an open PDF book) and the sentence or row you were on. It waits there, paused and
scrolled into view; press **Play** to continue. This is stored only in this browser (IndexedDB), never on
the server. **Clear** or **Close book** removes it, and you can turn it off in Settings under
**Keep my document and place after a refresh**.

### Export

**Export audio** generates the whole reading with your current voice, speed and pauses:

- One **WAV** file, or one **MP3** file (smaller, good for phones)
- One WAV per row, **zipped** (`Q001.wav`, `Q002.wav`, …)
- An `.srt` **transcript** with timestamps, for single-file exports

Exports run in the background, show progress, and can be cancelled. Playback stays responsive during an
export because playback requests always go first in the queue.

## Running with Docker

The repository includes a `Dockerfile` and `compose.yaml`. Docker builds the app on Linux with Node
22.23.2 and the exact package versions from `package-lock.json`, so it runs the same on any machine.

```bash
docker compose up --build
```

Then open <http://localhost:3000>.

| Task                                  | Command                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Use another port                      | `PORT=3123 docker compose up --build` (PowerShell: `$env:PORT=3123; docker compose up --build`) |
| Run in the background                 | `docker compose up -d --build`, then `docker compose logs -f` to watch                          |
| Stop                                  | `docker compose down`                                                                           |
| Delete the downloaded voice model too | `docker compose down -v`                                                                        |

How it differs from running with `npm start`:

- **The voice model lives in a Docker volume** (`readaloud-models`), not in `.cache/models`. It downloads
  once on the first start; later starts load it offline in a few seconds.
- **It is still private to your computer.** Inside the container the server listens on all of the
  container's interfaces (it has to, to be reachable at all), and `compose.yaml` publishes the port to
  `127.0.0.1` only. Keep that `127.0.0.1:` prefix if you edit the file; without it the app would be open to
  your whole network.
- **Use the same port on both sides** of the mapping. The server only accepts requests addressed to
  `localhost` on its own port, which is what `PORT` sets for both.
- **The image is about 950 MB**, mostly the speech engine. It runs as an unprivileged user, contains no
  test or build tools, and skips the GPU (CUDA) files the speech engine would otherwise download, because
  ReadAloud runs on the CPU.

## Configuration

`config.json`:

| Key            | Default                               | Notes                                                                |
| -------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `port`         | `3000`                                | The server always binds to `127.0.0.1` only. This cannot be changed. |
| `dtype`        | `fp32`                                | `fp32` (330 MB) or `q8` (90 MB). Also `fp16`, `q4`, `q4f16`.         |
| `defaultVoice` | `af_heart`                            | Used when no voice is saved in the browser                           |
| `model`        | `onnx-community/Kokoro-82M-v1.0-ONNX` |                                                                      |
| `cacheDir`     | `.cache/models`                       | Where the model is stored, relative to the project                   |

Environment variables override the file: `PORT`, `READALOUD_DTYPE`, `READALOUD_VOICE`, `READALOUD_CACHE_DIR`.

**Why `fp32` is the default:** on CPU, the 8-bit `q8` model was measured at about 0.9× real time
(1.5 s before the first audio of a short row) on an 8-thread laptop. `fp32` ran at about 0.27× real time
(0.45 s to first audio). Choose `q8` if download size matters more than speed.

### Manual model download

If the automatic download fails (for example behind a proxy), download these files from
<https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main> and place them like this:

```
.cache/models/onnx-community/Kokoro-82M-v1.0-ONNX/
├─ config.json
├─ tokenizer.json
├─ tokenizer_config.json
└─ onnx/
   └─ model.onnx              (for fp32; use model_quantized.onnx for q8)
```

Then press **Retry** in the app, or restart it.

## Troubleshooting

| Symptom                              | Fix                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| "Could not download the voice model" | Check the connection for the first run, then press **Retry**. Or use the manual download.  |
| `Port 3000 is already in use`        | Another app uses port 3000. Start with `PORT=3123 npm start`.                              |
| A table is read as plain text        | Set Mode to **Table (MCQ)**. If the first row is a title, set **Header row on row 2**.     |
| Wrong column read as the answer      | Change it in **Column mapping**. The spoken script column shows exactly what will be read. |
| No sound                             | Check the volume slider and the system output device. Press Play once to allow audio.      |

## Development

```bash
npm test             # Vitest: parser, mapping, script builder, player, TTS queue, export, audio
npm run lint         # ESLint
npm run format:check # Prettier
npm run dev          # restart on file changes
```

Project layout:

```
server/      Express app (index.js), Kokoro engine and job queue (tts.js),
             WAV/MP3/ZIP writers (audio.js), export jobs (export.js), config (config.js)
src/shared/  Pure modules used by both browser and tests: parser, html-table, mapping,
             script builder, chunker
public/      UI: index.html, styles.css, app.js (wiring), player.js (queue/prefetch/cache), views.js
test/        Unit tests and paste fixtures
```

### How it works

- The browser parses pastes with the shared parser and builds one script per row. Each row becomes two
  speech segments (question, then answer) so the pre-answer pause can be inserted.
- `POST /api/tts` returns a WAV for one segment with its pause appended as silence. Timing pauses with the
  audio clock keeps hands-free listening correct when the tab is in the background, where browsers
  throttle timers.
- The player requests the current segment first and prefetches the next two, so there is no gap between
  rows. Audio is cached in the browser (200 segments) and on the server (about 200 MB of PCM), so repeat
  and previous are instant.
- The server runs one generation at a time with three priorities: what you are waiting for, then
  prefetch, then export.

### Security

- Listens on `127.0.0.1` only. Requests with a non-local `Host` header are rejected (DNS-rebinding
  defence), and cross-origin `POST`/`DELETE` requests are rejected.
- Strict Content-Security-Policy with no inline scripts. All pasted content is rendered as text, never as
  HTML.
- Every API input is validated: text length, speed range, voice allowlist, pause range and export size.
- Pasted text is never logged.

`npm audit` reports advisories in two transitive packages, and no fixed versions exist upstream yet:

- `sharp` (libvips image decoding), pulled in by `@huggingface/transformers`. ReadAloud never passes images
  to it.
- `sprintf-js` (a denial-of-service issue with crafted format strings), reached through
  `onnxruntime-node` → `global-agent` → `roarr`. No user input reaches it.

## Licence

MIT for this app. Kokoro-82M is Apache-2.0. Voices and model are by hexgrad; the ONNX port is by
onnx-community.
