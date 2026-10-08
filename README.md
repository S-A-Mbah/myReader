# ReadAloud

ReadAloud reads your study material out loud, on your own computer, for free.

We built it as a support for our reading. We open a textbook PDF, jump to the chapter we're on, and
let it read while we follow the highlighted sentence on screen. When the voice reaches a part we want to
look at properly, we pause, scroll, then click the line in the player to get back to where it is.
It also reads question banks: paste a table of multiple-choice questions and it reads each question
and its answer, skipping the options. [ADD A LINE OF YOUR OWN: what you study with it, or when you use it.]

A friend asked for a copy, so here it is.

## It runs on your computer, for free

ReadAloud is meant to run locally, on the computer you're reading on.

- **No API, no account, no cost.** The voice is
  [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), an open-source speech model. It
  downloads once on the first start, then runs on your own CPU. No text is sent to an online voice service.
- **Read along.** The sentence being spoken is highlighted as it goes, so you can listen and read at the
  same time.
- **Not for website hosts like Vercel.** The voice model has to stay loaded in a program running on your
  machine, and those services only run short tasks. To share it, give someone the folder and they set it
  up the same way.

## What it does

- **Reads PDF textbooks.** The book's own table of contents becomes a clickable Contents list, so you can
  jump to any chapter or section. You can also type a page number to go straight there.
- **Reads question banks.** Paste rows from Excel, Google Sheets, Word, a web page, CSV or Markdown and
  each row is read as "Question 1. … Answer, B, Paris." The options are left out unless you ask for them.
- **Reads anything else as written.** Paste an article or notes and it reads sentence by sentence.
- **Shows where it is.** The sentence or row being read is highlighted. The view stays where you scroll;
  click the line shown in the player to jump back to it.
- **Remembers your place.** Refresh or reopen the page and your document comes back, paused on the
  sentence you were on.
- **Exports audio.** Save a reading as WAV or MP3 (or one file per question, zipped) to listen on your
  phone.
- **Lets you tune it.** 28 voices, speed from 0.5× to 2×, pause lengths, a quiz mode with a longer pause
  before each answer, light and dark themes.
- **Stays private.** It runs on your machine at `127.0.0.1` only. Nothing you load is uploaded anywhere,
  and after the first run it works offline.

## Set it up

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. The first start downloads the voice model (about 330 MB) and shows the
progress at the top of the page. After that it starts without the internet.

If port 3000 is taken, run `PORT=3123 npm start` (on Windows PowerShell: `$env:PORT=3123; npm start`) and
open that port instead.

### Or run it with Docker

If you have [Docker](https://www.docker.com/products/docker-desktop/), you don't need Node.js, and you
get the same setup we tested, whatever your computer:

```bash
docker compose up --build
```

Open <http://localhost:3000>. The first start downloads the voice model (about 330 MB) into a Docker
volume, so it only happens once. Stop it with `Ctrl+C`, or `docker compose down`. The app is only
reachable from your own computer, as when it runs without Docker.

## Good to know

- Scanned PDFs (photos of pages with no selectable text) can't be read.
- PDFs with two columns, side boxes or footnotes may be read in a slightly odd order.
- Space plays and pauses. → and ← move one sentence or row; Shift + → and ← move one section in a book.

Everything else (settings, export options, configuration, troubleshooting) is in the
[full guide](docs/GUIDE.md).
