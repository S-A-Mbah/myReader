/**
 * Playback engine: a queue of items (rows or sentences), each made of segments.
 * Prefetches ahead (FR-37), keeps an LRU cache of audio (FR-38), and drives a
 * single <audio> element.
 *
 * Pauses are baked into each segment's WAV as trailing silence by the server, so
 * the between-row pause is timed by the audio clock. That keeps hands-free
 * listening correct in a background tab, where browsers throttle timers.
 */

/**
 * @typedef {{text: string, pauseAfterMs: number}} Segment
 * @typedef {{segments: Segment[], skipped?: boolean}} Item
 * @typedef {'stopped'|'buffering'|'playing'|'paused'} PlayerState
 * @typedef {{voice: string, speed: number}} Voice
 */

const CACHE_LIMIT = 200;
const PREFETCH_SEGMENTS = 2;

class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export class Player {
  /**
   * @param {Object} o
   * @param {HTMLAudioElement} o.audio
   * @param {(seg: Segment, voice: Voice, signal: AbortSignal, prefetch: boolean) => Promise<Blob>} o.fetchAudio
   * @param {(state: PlayerState) => void} o.onState
   * @param {(index: number) => void} o.onPosition
   * @param {(err: Error) => void} o.onError
   */
  constructor({ audio, fetchAudio, onState, onPosition, onError }) {
    this.audio = audio;
    this.fetchAudio = fetchAudio;
    this.onState = onState;
    this.onPosition = onPosition;
    this.onError = onError;
    /** @type {Item[]} */
    this.items = [];
    this.index = 0;
    this.segIndex = 0;
    /** @type {PlayerState} */
    this.state = 'stopped';
    this.loop = false;
    /** @type {Voice} */
    this.voice = { voice: 'af_heart', speed: 1 };
    /** Incremented to cancel the running loop. */
    this.token = 0;
    this.loopRunning = false;
    /** @type {Map<string, Blob>} */
    this.cache = new Map();
    /** @type {Map<string, {promise: Promise<Blob>, controller: AbortController}>} */
    this.inflight = new Map();
    /** @type {(() => void) | null} */
    this.cancelPlayback = null;
    /** @type {(() => void) | null} */
    this.unpause = null;
    /** @type {string|null} */
    this.objectUrl = null;
    /** True while a segment is loaded in the <audio> element and has not ended. */
    this.segmentLoaded = false;
    /** True after playback ran off the end of the list. */
    this.finished = false;
  }

  /* ------------------------------------------------------------- public */

  /**
   * Replace the playlist. Keeps the position when possible.
   * @param {Item[]} items
   * @param {{keepPosition?: boolean}} [opts]
   */
  setItems(items, opts = {}) {
    const wasActive = this.state !== 'stopped';
    this.items = items;
    if (!opts.keepPosition || this.index >= items.length) {
      this.#halt();
      this.index = 0;
      this.segIndex = 0;
      this.#setState('stopped');
      this.onPosition(this.items.length ? this.index : -1);
      return;
    }
    // Same position, new content (template or mapping changed): applies from the next segment.
    this.#prunePrefetch();
    if (wasActive) this.#prefetchAhead();
  }

  /** @param {Voice} v */
  setVoice(v) {
    if (v.voice === this.voice.voice && v.speed === this.voice.speed) return;
    this.voice = { ...v };
    // FR-39: drop queued prefetches; the current segment finishes with the old voice.
    this.#prunePrefetch(true);
    if (this.state === 'playing' || this.state === 'buffering') this.#prefetchAhead();
  }

  /** @param {number} v 0..1 */
  setVolume(v) {
    this.audio.volume = Math.min(1, Math.max(0, v));
  }

  /** @param {boolean} v */
  setLoop(v) {
    this.loop = v;
  }

  /** @param {number} [from] item index */
  play(from) {
    if (!this.items.length) return;
    if (typeof from === 'number') {
      this.#jump(from, true);
      return;
    }
    if (this.state === 'paused') {
      this.resume();
      return;
    }
    if (this.state !== 'stopped') return;
    if (this.finished) {
      // Reached the end last time: Play starts over rather than repeating the last item.
      this.index = 0;
      this.segIndex = 0;
    }
    this.#start();
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'buffering') return;
    this.audio.pause();
    this.#setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    if (!this.loopRunning) {
      this.#start();
      return;
    }
    const fn = this.unpause;
    this.unpause = null;
    if (fn) {
      // A segment arrived while paused and is waiting to start.
      this.#setState('buffering');
      fn();
    } else if (this.segmentLoaded) {
      // Paused mid-segment: continue it.
      this.#setState('playing');
      this.#playAudio();
    } else {
      // Paused between segments while the next one generates: the run loop starts it.
      this.#setState('buffering');
    }
  }

  toggle() {
    if (this.state === 'playing' || this.state === 'buffering') this.pause();
    else this.play();
  }

  stop() {
    this.#halt();
    this.segIndex = 0;
    this.#setState('stopped');
    this.onPosition(this.items.length ? this.index : -1);
  }

  next() {
    const i = this.#nextPlayable(this.index + 1, 1);
    if (i >= 0) this.#jump(i);
  }

  prev() {
    const i = this.#nextPlayable(this.index - 1, -1);
    if (i >= 0) this.#jump(i);
  }

  repeat() {
    this.#jump(this.index, this.state === 'stopped');
  }

  /**
   * Move to an item. Playing keeps playing; paused stays paused at the new spot.
   * @param {number} i
   */
  seek(i) {
    this.#jump(i);
  }

  /** Forget cached audio (e.g. after the server restarts). */
  clearCache() {
    this.cache.clear();
  }

  /* ------------------------------------------------------------ internals */

  /** @param {PlayerState} s */
  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  /**
   * @param {number} from
   * @param {1|-1} dir
   */
  #nextPlayable(from, dir) {
    for (let i = from; i >= 0 && i < this.items.length; i += dir) {
      if (!this.items[i].skipped && this.items[i].segments.length) return i;
    }
    return -1;
  }

  /**
   * @param {number} i
   * @param {boolean} [forcePlay]
   */
  #jump(i, forcePlay = false) {
    if (!this.items.length) return;
    const target = Math.max(0, Math.min(i, this.items.length - 1));
    const wasPlaying = this.state === 'playing' || this.state === 'buffering';
    const wasPaused = this.state === 'paused';
    this.#halt();
    this.finished = false;
    this.index = target;
    this.segIndex = 0;
    this.onPosition(this.index);
    if (wasPlaying || forcePlay) this.#start();
    else if (wasPaused) this.#setState('paused'); // resume() starts from the new item
    this.#prunePrefetch();
  }

  /** Cancel the running loop and current audio. */
  #halt() {
    this.token++;
    this.loopRunning = false;
    if (this.cancelPlayback) this.cancelPlayback();
    this.cancelPlayback = null;
    this.unpause = null;
    this.segmentLoaded = false;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.#revoke();
  }

  #revoke() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  #start() {
    const first = this.#nextPlayable(this.index, 1);
    if (first < 0) {
      // Nothing playable from here; wrap if looping, otherwise do nothing.
      const wrap = this.loop ? this.#nextPlayable(0, 1) : -1;
      if (wrap < 0) {
        this.#setState('stopped');
        return;
      }
      this.index = wrap;
    } else if (first !== this.index) {
      this.index = first;
      this.segIndex = 0;
    }
    const token = ++this.token;
    this.loopRunning = true;
    this.finished = false;
    this.#setState('buffering');
    this.#run(token).catch((err) => {
      if (token !== this.token) return;
      this.loopRunning = false;
      this.#setState('stopped');
      this.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** @param {number} token */
  async #run(token) {
    while (token === this.token) {
      const item = this.items[this.index];
      if (!item) break;
      if (item.skipped || !item.segments.length) {
        this.index++;
        this.segIndex = 0;
        if (this.index >= this.items.length) break;
        continue;
      }
      this.onPosition(this.index);
      // Bound by the live item: a template edit can change its segment count mid-play.
      for (; this.segIndex < (this.items[this.index]?.segments.length ?? 0); this.segIndex++) {
        if (token !== this.token) return;
        if (!this.items[this.index]?.segments[this.segIndex]) break;
        if (this.state !== 'paused') this.#setState('buffering');
        /** @type {Blob|null} */
        let blob = null;
        while (!blob) {
          // Re-read each try: a voice or template change aborts the stale request,
          // and the segment is then fetched again with the new settings.
          const seg = this.items[this.index]?.segments[this.segIndex];
          if (!seg) break;
          try {
            // Request the current segment before the prefetches: the server queue is
            // first-in first-out, so this order is what makes Play start quickly.
            const current = this.#get(seg, this.voice);
            this.#prefetchAhead();
            blob = await current;
          } catch (err) {
            if (token !== this.token) return;
            if (/** @type {Error} */ (err)?.name !== 'AbortError') throw err;
          }
        }
        if (token !== this.token) return;
        if (!blob) break;
        await this.#playBlob(blob, token);
        if (token !== this.token) return;
      }
      this.segIndex = 0;
      const nextIdx = this.#nextPlayable(this.index + 1, 1);
      if (nextIdx >= 0) {
        this.index = nextIdx;
        continue;
      }
      if (this.loop) {
        const first = this.#nextPlayable(0, 1);
        if (first >= 0) {
          this.index = first;
          continue;
        }
      }
      break;
    }
    if (token === this.token) {
      this.loopRunning = false;
      this.finished = true;
      this.#revoke();
      this.#setState('stopped');
      this.onPosition(this.index);
    }
  }

  /**
   * Play one blob to the end. Resolves on 'ended' or when cancelled.
   * @param {Blob} blob
   * @param {number} token
   */
  #playBlob(blob, token) {
    return new Promise((resolve, reject) => {
      this.#revoke();
      this.objectUrl = URL.createObjectURL(blob);
      const audio = this.audio;
      const done = () => {
        this.segmentLoaded = false;
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        this.cancelPlayback = null;
      };
      const onEnded = () => {
        done();
        resolve(undefined);
      };
      const onError = () => {
        done();
        if (token !== this.token) resolve(undefined);
        else reject(new Error('The browser could not play this audio.'));
      };
      this.cancelPlayback = () => {
        done();
        resolve(undefined);
      };
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      audio.src = this.objectUrl;
      this.segmentLoaded = true;
      if (this.state === 'paused') {
        // Buffered while paused: wait for resume() before starting.
        this.unpause = () => this.#playAudio();
      } else {
        this.#playAudio();
      }
    });
  }

  #playAudio() {
    this.audio.play().then(
      () => {
        if (this.state === 'buffering') this.#setState('playing');
      },
      (err) => {
        if (err?.name === 'AbortError') return; // src changed mid-start
        // Autoplay was refused (no user gesture yet): pause and let the user press Play.
        this.#setState('paused');
        this.unpause = () => this.#playAudio();
        if (err?.name !== 'NotAllowedError') this.onError(err);
      },
    );
  }

  /**
   * @param {Segment} seg
   * @param {Voice} v
   */
  #key(seg, v) {
    return `${v.voice}|${v.speed}|${seg.pauseAfterMs}|${seg.text}`;
  }

  /**
   * Cached or in-flight audio for a segment.
   * @param {Segment} seg
   * @param {Voice} v
   * @param {boolean} [prefetch]
   * @returns {Promise<Blob>}
   */
  #get(seg, v, prefetch = false) {
    const key = this.#key(seg, v);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU order
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = this.#fetchWithRetry(seg, v, controller.signal, prefetch).then(
      (blob) => {
        this.inflight.delete(key);
        this.cache.set(key, blob);
        while (this.cache.size > CACHE_LIMIT) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return blob;
      },
      (err) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    promise.catch(() => {}); // prefetch failures surface when (if) the segment is played
    this.inflight.set(key, { promise, controller });
    return promise;
  }

  /**
   * One retry for transient failures (server busy, network blip).
   * @param {Segment} seg
   * @param {Voice} v
   * @param {AbortSignal} signal
   * @param {boolean} prefetch
   */
  async #fetchWithRetry(seg, v, signal, prefetch) {
    try {
      return await this.fetchAudio(seg, v, signal, prefetch);
    } catch (err) {
      if (signal.aborted || /** @type {any} */ (err)?.permanent) throw err;
      await new Promise((r) => setTimeout(r, 800));
      if (signal.aborted) throw new AbortedError();
      return this.fetchAudio(seg, v, signal, prefetch);
    }
  }

  /** Segments that should be fetched next, in order. @returns {Segment[]} */
  #upcoming() {
    /** @type {Segment[]} */
    const out = [];
    let i = this.index;
    let s = this.segIndex + 1;
    let guard = 0;
    while (out.length < PREFETCH_SEGMENTS && guard++ < this.items.length + 2) {
      const item = this.items[i];
      if (!item) {
        if (!this.loop) break;
        i = 0;
        s = 0;
        continue;
      }
      if (!item.skipped) {
        for (; s < item.segments.length && out.length < PREFETCH_SEGMENTS; s++) out.push(item.segments[s]);
      }
      i++;
      s = 0;
    }
    return out;
  }

  #prefetchAhead() {
    for (const seg of this.#upcoming()) this.#get(seg, this.voice, true);
  }

  /**
   * Abort in-flight requests that are no longer the current or next segments.
   * @param {boolean} [all] abort everything except the current segment
   */
  #prunePrefetch(all = false) {
    const keep = new Set();
    const cur = this.items[this.index]?.segments[this.segIndex];
    if (cur) keep.add(this.#key(cur, this.voice));
    if (!all) for (const seg of this.#upcoming()) keep.add(this.#key(seg, this.voice));
    for (const [key, { controller }] of this.inflight) {
      if (!keep.has(key)) {
        controller.abort();
        this.inflight.delete(key);
      }
    }
  }
}
