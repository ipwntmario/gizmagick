import { chooseNextClip } from "./transitions.js";
// audioEngine.js
export class AudioEngine {
  constructor({
    onStatus,
    onSectionChange,
    onQueueChange,
    onModeChange,
    onModeQueueChange,
    onReady
  } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onSectionChange = onSectionChange || (() => {});
    this.onQueueChange = onQueueChange || (() => {});
    this.onModeChange = onModeChange || (() => {});
    this.onModeQueueChange = onModeQueueChange || (() => {});
    this.onReady = onReady || (() => {});

    this.audioCtx = null;
    this.masterGain = null;

    this._bufferCache = new Map(); // url -> AudioBuffer

    this.fadeOutSeconds = 6;
    this.userGain = 1.0;
    this.pauseFadeSeconds = 1;

    this.isPaused = false;
    this.pausedInfo = null; // { clipName, offsetSeconds? }

    // track & dataset
    this.clipData = {};
    this.sectionData = {};
    this.trackData = {};
    this.lastTrackName = null;

    // preloading / playback
    this.activeClips = {};       // { clipName: { source, gainNode, buffersByMode, startedAt, offsetAtStart } }
    this.scheduledTimeouts = []; // [timeoutId]
    this._playbackToken = 0; // increments each new playClip; stale timers check this
    this._isPreloaded = false;
    this._preloadToken = 0;

    // section & mode state
    this.currentSectionName = null;
    this.queuedNextSectionName = null;

    this.currentModeName = "base";
    this.queuedNextModeName = null;

    this.lastPlayingClipName = null;
    this.currentTrackName = null;

    // cache section->availableModes (includes "base")
    this.sectionModes = new Map();

    // stop-state
    this._stopPendingUntil = 0;     // audio time when the global stop fade ends (0 = none)
    this._stopFinishTimer = null;   // timeout id for finishing stop
    this._stopFadeStartedAt = 0;
    this._stopFadeDuration = 0;
    this._stopFadeStartGain = 0;

    // RNG/debug
    this._seed = null;
    this._rng = Math.random;
    this._rngDraws = 0;
    this._rngDebug = false; // flip to false once things are stable
    // After a mid-clip jump, force the first loopPoint to honor only clip.nextClip
    this._stayInSectionOnce = false;

    // ---- warm-start support ----
    this.enablePreloadWarmStart = false;  // default true; set false to disable
    this.enableLateJoinWarmStart = false; // default true; set false to disable
    this.WARMUP_LEAD_MS = 500;            // Δ, can tune 300–500ms
    this._warmStart = null;               // { clipName, source, gainNode, timerId|null }
    this._defaultStartSection = null;     // computed at preload
  }

  /**
   * Snapshot the precise current musical position.
   * Returns null if nothing is playing.
   */
  getNowPlaying() {
    if (!this.audioCtx) return null;
    const clipName = this.lastPlayingClipName;
    if (!clipName) return null;
    const entry = this.activeClips?.[clipName];
    if (!entry) return null;
    const ctx = this.audioCtx;
    const elapsed = Math.max(0, ctx.currentTime - (entry.startedAt || ctx.currentTime));
    const offsetSeconds = (entry.offsetAtStart || 0) + elapsed;
    return {
      trackName: this.currentTrackName || null,
      sectionName: this.currentSectionName || null,
      modeName: this.currentModeName || "base",
      clipName,
      offsetSeconds,
      seed: this._seed ?? null,
      rngDrawCount: this._rngDraws | 0,
    };
  }

  /**
   * Jump to an exact musical position (must already be preloaded).
   * Starts the given clip with an offset, setting section/mode consistently.
   */
  playAtPosition({ sectionName, modeName = "base", clipName, offsetSeconds = 0, warmStartDeltaSec = 0 } = {}) {
    if (this.audioCtx && this.audioCtx.state !== "running") {
      if (this._rngDebug) console.warn("[ENGINE] playAtPosition ignored: AudioContext suspended");
      return;
    }

    if (!sectionName || !clipName) return;
    // Set section & mode before starting the clip
    this.setCurrentSection(sectionName);
    this.setCurrentMode(modeName || "base");
    // Ensure first loop after a mid-clip jump doesn’t take queued/section/mode detours
    this._stayInSectionOnce = !this._isAutoSectionTransitionPending(sectionName);

    const Δ = Math.max(0, Number(warmStartDeltaSec) || 0);
    if (Δ <= 0) {
      // Old behavior: start immediately at this exact position
      this._clearWarmStart(); // make sure
      this.playClip(clipName, { offsetSeconds, skipFadeIn: true });
      return;
    }
    // Look ahead deterministically to the state at t+Δ
    let future = null;
    try {
      future = this._computeFuturePosition({
        deltaSec: Δ,
        sectionName,
        modeName: modeName || "base",
        clipName,
        offsetSeconds,
        seed: this._seed ?? 1,
        rngDrawCount: this._rngDraws | 0
      });
    } catch (e) {
      console.warn("[ENGINE][WARM] future compute failed; falling back to immediate start:", e);
      this.playClip(clipName, { offsetSeconds, skipFadeIn: true });
      return;
    }
    if (!future) {
      this.playClip(clipName, { offsetSeconds, skipFadeIn: true });
      return;
    }
    const { sectionName: fSec, modeName: fMode, clipName: fClip, offsetSeconds: fOffset } = future;

    // At Δ later, start the exact node at offset and unmute; stop the warm one.
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const when = now + Δ;

    // Warm start (muted) of the future clip now (keeps the device/graph hot)
    try {
      if (this.enableLateJoinWarmStart) {
        this._clearWarmStart();
        const ws = this._startMutedClip(fClip, { modeName: fMode, offsetSeconds: (this.clipData[fClip]?.loopStart || 0) });
        if (ws) {
          this._warmStart = { clipName: fClip, ...ws, timerId: null };
          if (this._rngDebug) console.log("[ENGINE][WARM] late-join spun muted:", fClip, "mode:", fMode);
        }
      }
    } catch (e) {
      console.warn("[ENGINE][WARM] spin future muted failed:", e);
    }

    // Arm the precise start now (audio-time), not with a JS timer
    this.setCurrentSection(fSec);
    this.setCurrentMode(fMode);

    // Sample-accurate start at `when` with exact offset
    this._clearWarmStart();   // ensure no warmer survives
    this._playClipAtAudioTime(fClip, {
      modeName: fMode,
      offsetSeconds: fOffset,
      startAtAudioTime: when,
      skipFadeIn: true
    });

    // After the new node ramps in, nuke any other sources so nothing can loop under it.
    const sweepAt = when + 0.03; // 30ms after start
    this.schedule(() => this._stopAllExcept(fClip), sweepAt);

    // Stop the warm node right after we’ve ramped in the real one
    try {
      const killAt = when + 0.02; // small margin after ramp
      this.schedule(() => this._clearWarmStart(), killAt);
    } catch {}

  }

  /**
   * Handle the loopPoint transition for a given clip.
   * Honors one-shot _stayInSectionOnce guard, queued section/mode,
   * then falls back to deterministic nextClip (seeded RNG).
   */
  _handleLoopPointForClip(currentClipName) {
    const clip = this.clipData[currentClipName];
    if (!clip) return;
    const skipQueue = this._stayInSectionOnce;
    this._stayInSectionOnce = false;
    if (!skipQueue && this.queuedNextSectionName) {
      const sectionName = this.queuedNextSectionName;
      const next = this.sectionData[sectionName]?.firstClip;
      const modes = this.getAvailableModes(sectionName);
      this.clearScheduled();
      this.setCurrentSection(sectionName);
      this.setCurrentMode(modes.includes(this.currentModeName) ? this.currentModeName : 'base');
      this.clearQueuedSection();
      this.clearQueuedMode();
      if (next && this.activeClips[next]) this.playClip(next);
      return;
    }
    if (!skipQueue && this.queuedNextModeName) {
      const modes = this.getAvailableModes(this.currentSectionName);
      this.setCurrentMode(modes.includes(this.queuedNextModeName) ? this.queuedNextModeName : 'base');
      this.clearQueuedMode();
    }
    const next = chooseNextClip(clip.nextClip, () => this.rand());
    if (next && this.activeClips[next]) this.playClip(next);
  }

  get isPlaying() {
    return !!this.lastPlayingClipName;
  }
  get isPreloaded() {
    return !!this._isPreloaded;
  }

  ensureContext() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });
    }
    // Ensure master chain exists
    if (!this.masterGain) {
      const g = this.audioCtx.createGain();
      g.gain.value = this.userVolume ?? 1; // your saved user volume, or 1
      g.connect(this.audioCtx.destination);
      this.masterGain = g;
    }
    // A separate, always-zero bus for warm-start nodes (never altered)
    if (!this.warmBus) {
      const warm = this.audioCtx.createGain();
      warm.gain.value = 0;                 // <- stays 0 forever
      warm.connect(this.masterGain);       // still in the graph so it runs
      this.warmBus = warm;
    }
    return this.audioCtx;
  }

  // Build a safe URL for audio files: encode base path (keeps slashes) and filename.
  _buildAudioUrl(filename) {
    return this._buildAudioUrlForBase(filename, this.trackBase);
  }

  _buildAudioUrlForBase(filename, basePath) {
    const base = basePath ? String(basePath) : "";
    // encodeURI keeps "/" intact for the base path; it encodes spaces etc.
    const safeBase = encodeURI(base.replace(/([^:])\/{2,}/g, "$1/"));
    // encodeURIComponent for the file segment to handle "&", spaces, etc.
    const safeFile = encodeURIComponent(String(filename));
    // Normalize any accidental doubles again after join
    return `${safeBase}/audio/${safeFile}`.replace(/([^:])\/{2,}/g, "$1/");
  }

  // Load & decode with per-URL cache + loud error logging.
  // meta: { clipName, mode } is optional and only used for better console messages.
  async _loadBufferWithCache(url, ctx, meta = {}) {
    if (this._bufferCache.has(url)) return this._bufferCache.get(url);

    let res, arr, buf;
    try {
      res = await fetch(url);
    } catch (e) {
      console.error("[AUDIO] network error while fetching", { url, ...meta, error: e });
      throw e;
    }

    if (!res.ok) {
      console.error("[AUDIO] fetch failed", {
        url, status: res.status, statusText: res.statusText, ...meta
      });
      throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "unknown/unknown";
    try {
      arr = await res.arrayBuffer();
    } catch (e) {
      console.error("[AUDIO] failed to read ArrayBuffer", { url, contentType, ...meta, error: e });
      throw e;
    }

    try {
      // slice(0) to detach from the original ArrayBuffer in some browsers
      buf = await ctx.decodeAudioData(arr.slice(0));
    } catch (e) {
      console.error("[AUDIO] decode failed", {
        url,
        contentType,
        bytes: arr?.byteLength ?? 0,
        ...meta,
        error: e
      });
      // Common reasons: wrong URL (404 HTML), non-Vorbis file, corrupted file.
      throw e;
    }

    this._bufferCache.set(url, buf);
    return buf;
  }

  setUserVolume(v) {
    const ctx = this.ensureContext();
    const val = Math.max(0, Math.min(1, Number(v) || 0));
    this.userGain = val;
    if (this.masterGain) {
      // If a stop fade is in progress, don't stomp the ramp.
      const now = ctx.currentTime;
      if (this._stopPendingUntil && now < this._stopPendingUntil) {
        // defer applying; master is ramping to 0
      } else {
        this.masterGain.gain.setValueAtTime(val, now);
      }
    }
  }

  setTrackVolume(v) {
    // Central track volume (0..1)
    const ctx = this.ensureContext();
    const val = Math.max(0, Math.min(1, Number(v) || 0));
    this.trackVolume = val;
    // If a global stop fade is in progress, don't stomp its automation.
    const now = ctx.currentTime;
    if (this._stopPendingUntil && now < this._stopPendingUntil) return;
    // Apply immediately to all active clip gains
    try {
      Object.values(this.activeClips).forEach(({ gainNode }) => {
        if (!gainNode) return;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(val, now);
      });
    } catch {}
  }

  setFadeOutSeconds(n) {
    this.fadeOutSeconds = Math.max(0, Math.min(30, Number(n) || 0));
  }

  setPauseFadeSeconds(n) {
    this.pauseFadeSeconds = Math.max(1, Math.min(30, Number(n) || 1));
  }

  // ---- deterministic RNG API ----
  setRandomSeed(seed) {
    // Accept 32-bit integer; fall back to 1 if someone passes 0/NaN
    const s = (Number(seed) >>> 0) || 1;
    this._seed = s;
    try {
      this._rng = mulberry32(s);
    } catch {
      this._rng = Math.random;
    }
    this._rngDraws = 0;
    if (this._rngDebug) console.log(`[ENGINE][RNG] setRandomSeed=${s}`);
  }
  rand() {
    try {
      const r = this._rng ? this._rng() : Math.random();
      this._rngDraws += 1;
      if (this._rngDebug) console.log(`[ENGINE][RNG] draw#${this._rngDraws} → ${r}`);
      return r;
    } catch {
      const r = Math.random();
      if (this._rngDebug) console.log(`[ENGINE][RNG] draw#${++this._rngDraws} (fallback) → ${r}`);
      return r;
    }
  }

  getRngDrawCount() {
    return this._rngDraws | 0;
  }

  fastForwardRng(n) {
    // Advance RNG deterministically to match GM’s draw count
    const count = Math.max(0, Number(n) | 0);
    if (!count) return;
    for (let i = 0; i < count; i++) {
      // Discarded draws (still increment counter for truthful state)
      const _ = this.rand();
    }
    if (this._rngDebug) console.log(`[ENGINE][RNG] fast-forwarded to draw#${this._rngDraws}`);
  }

  setData({ clips, sections, tracks }) {
    this.clipData = clips || {};
    this.sectionData = sections || {};
    this.trackData = tracks || {};
    // recompute modes per section (always include "base")
    this.sectionModes = new Map(
      Object.entries(this.sectionData).map(([name, s]) => {
        const extra = Array.isArray(s?.modes) ? s.modes : (s?.modes ? [s.modes] : []);
        const modes = ["base", ...extra.filter(Boolean)];
        return [name, modes];
      })
    );
  }

  clearScheduled() {
    this.scheduledTimeouts.forEach(clearTimeout);
    this.scheduledTimeouts = [];
    for (const entry of Object.values(this.activeClips)) {
      clearTimeout(entry.timerId);
      entry.timerId = null;
    }
  }

  _clearActiveClipsSilently() {
    Object.values(this.activeClips).forEach(({ source }) => {
      try { source.stop(); } catch {}
    });
    this.activeClips = {};
    this._isPreloaded = false;
  }

  // Leaving a session only changes this client's playback. Do not emit a stop
  // status, since that can release a queued track or affect the room state.
  resetForSession() {
    this._preloadToken += 1;
    this._playbackToken += 1;
    if (this._stopFinishTimer) clearTimeout(this._stopFinishTimer);
    this._stopFinishTimer = null;
    if (this._pauseFinishTimer) clearTimeout(this._pauseFinishTimer);
    this._pauseFinishTimer = null;
    this._clearWarmStart();
    this.clearScheduled();
    this._clearActiveClipsSilently();
    this._stopPendingUntil = 0;
    this._stopFadeStartedAt = 0;
    this._stopFadeDuration = 0;
    this._stopFadeStartGain = 0;
    this.isPaused = false;
    this.pausedInfo = null;
    this.lastPlayingClipName = null;
    this.lastTrackName = null;
    this.currentTrackName = null;
    this.currentSectionName = null;
    this.currentModeName = "base";
    this.queuedNextSectionName = null;
    this.queuedNextModeName = null;
    this._defaultStartSection = null;
    this.clipData = {};
    this.sectionData = {};
    this.sectionModes = new Map();
    if (this.audioCtx && this.masterGain) {
      const now = this.audioCtx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.userGain, now);
    }
  }

  /**
   * Hard stop used at a track's true end (end-section, last clip).
   * - No fade
   * - Stop sources now, clear timers
   * - Reset flags & restore master to user volume
   */
  _hardStopAtEnd() {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;

    // If a soft-stop fade was armed for any reason, cancel it.
    if (this._stopFinishTimer) {
      clearTimeout(this._stopFinishTimer);
      this._stopFinishTimer = null;
    }
    this._stopPendingUntil = 0;
    this._stopFadeStartedAt = 0;
    this._stopFadeDuration = 0;
    this._stopFadeStartGain = 0;

    // Stop all clip sources immediately
    try {
      Object.values(this.activeClips).forEach(({ source }) => {
        try { source && source.stop(); } catch {}
      });
    } catch {}

    // Prevent any additional scheduled transitions from firing
    this.clearScheduled();

    // Reset engine state
    this.activeClips = {};
    this.lastPlayingClipName = null;
    this._isPreloaded = false;
    this.isPaused = false;
    this.pausedInfo = null;

    // Put master back at user volume (so the next Play starts at the right level)
    try {
      const now = ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.userGain ?? 1, now);
    } catch {}

    this.onStatus?.("Stopped");
  }

  setCurrentSection(name) {
    this.currentSectionName = name || null;
    this.onSectionChange?.(this.currentSectionName);
  }

  // ----- modes API -----
  getAvailableModes(sectionName) {
    return this.sectionModes.get(sectionName) || ["base"];
  }

  setCurrentMode(modeName) {
    const modes = this.getAvailableModes(this.currentSectionName);
    const chosen = modes.includes(modeName) ? modeName : "base";
    this.currentModeName = chosen;
    this.onModeChange?.(chosen);
  }

  queueModeTransition(modeNameOrNull) {
    // only queue if it exists for the *current* section
    if (modeNameOrNull) {
      const modes = this.getAvailableModes(this.currentSectionName);
      if (!modes.includes(modeNameOrNull)) return;
      this.queuedNextModeName = modeNameOrNull;
    } else {
      this.queuedNextModeName = null;
    }
    this.onModeQueueChange?.(this.queuedNextModeName);
  }

  clearQueuedMode() {
    this.queuedNextModeName = null;
    this.onModeQueueChange?.(null);
  }

  // ----- preload -----
  async cacheTrackBuffers(trackName, clipData, { basePath } = {}) {
    const ctx = this.ensureContext();
    const entries = Object.entries(clipData || {});
    for (const [clipName, clipObj] of entries) {
      const fileMap = this._normalizeFileMap(clipObj?.file);
      for (const [mode, filename] of Object.entries(fileMap)) {
        if (!filename) continue;
        const url = this._buildAudioUrlForBase(filename, basePath || `/tracks/${trackName}`);
        await this._loadBufferWithCache(url, ctx, { trackName, clipName, mode });
      }
    }
  }

  async preloadTrack(trackName, opts = {}) {
    const ctx = this.ensureContext();
    const preloadToken = ++this._preloadToken;

    this.lastTrackName = trackName;

    const { basePath, trackVolume, preserveCache = false } = opts || {};
    if (typeof trackVolume === "number") this.setTrackVolume(trackVolume);
    this.trackBase = basePath ? String(basePath) : this.trackBase;

    // If not playing but we had previous preloaded sources, clear them
    if (!this.isPlaying && Object.keys(this.activeClips).length > 0) {
      this._clearActiveClipsSilently();
    }
    // If playing, defer
    if (this.isPlaying) {
      this.onStatus?.("Preload deferred: still playing");
      return;
    }

    if (!preserveCache && !this.isPlaying && this.currentTrackName && this.currentTrackName !== trackName) {
      this._bufferCache.clear(); // simple policy; or implement an LRU later
    }

    this.currentTrackName = trackName;
    this._isPreloaded = false;

    // Decode all clips + all mode files to buffers
    this.activeClips = {};
    const activeUrls = new Set();
    const clipEntries = Object.entries(this.clipData);

    for (const [clipName, clipObj] of clipEntries) {
      const fileMap = this._normalizeFileMap(clipObj?.file);
      const modes = Object.keys(fileMap);
      if (modes.length === 0) continue;

      const buffersByMode = {};
      for (const modeKey of modes) {
        const fname = fileMap[modeKey];
        if (!fname) continue;

        // NEW: build a safe URL and pass clip/mode meta for precise error logs
        const url = this._buildAudioUrl(fname);
        activeUrls.add(url);
        const buf = await this._loadBufferWithCache(url, this.audioCtx || ctx, {
          clipName,
          mode: modeKey
        });
        if (preloadToken !== this._preloadToken) return;
        buffersByMode[modeKey] = buf;
      }

      // store buffers; source/gainNode allocated when playing
      this.activeClips[clipName] = {
        source: null,
        gainNode: null,
        buffersByMode,
        startedAt: 0,
        offsetAtStart: 0
      };
    }

    if (preserveCache) {
      for (const url of this._bufferCache.keys()) {
        if (!activeUrls.has(url)) this._bufferCache.delete(url);
      }
    }

    this._isPreloaded = true;
    this.onStatus?.(`Track '${trackName}' preloaded`);
    this.onReady?.();
    console.log("[ENGINE] preloadTrack complete for", trackName,
                "currentTrackName:", this.currentTrackName);
    // ---- Warm-start: spin up first section's first clip muted (no scheduling) ----
    if (this.enablePreloadWarmStart) {
      try {
        this._clearWarmStart();
        this._defaultStartSection = this._computeDefaultStartSection();
        const secName = this._defaultStartSection;
        const sec = secName ? this.sectionData?.[secName] : null;
        const firstClip = sec?.firstClip;
        if (firstClip && this.activeClips[firstClip]) {
          const ws = this._startMutedClip(firstClip, {
            modeName: "base",
            offsetSeconds: (this.clipData[firstClip]?.loopStart || 0)
          });
          if (ws) {
            this._warmStart = { clipName: firstClip, ...ws, timerId: null };
            if (this._rngDebug) console.log("[ENGINE][WARM] preloaded muted first clip:", firstClip);
          }
        }
      } catch (e) {
        console.warn("[ENGINE][WARM] preload warm-start failed:", e);
      }
    }
  }

  // ----- stop -----
  stopTrack(withFade = true, fadeSecondsOverride = null) {
    if (!this.audioCtx) return;

    const ctx = this.audioCtx;
    const now = ctx.currentTime;
    const fade = withFade ? Math.max(0, Number(fadeSecondsOverride ?? this.fadeOutSeconds) || 0) : 0;

    // If a stop is already pending, extend or keep the earliest finish
    if (this._stopFinishTimer) {
      clearTimeout(this._stopFinishTimer);
      this._stopFinishTimer = null;
    }

    if (fade > 0) {
      // Let all existing transitions continue. Just fade the MASTER to 0.
      try {
        const g = this.masterGain.gain;
        const previousFadeActive = this._stopPendingUntil > now && this._stopFadeDuration > 0;
        const previousFadeFraction = previousFadeActive
          ? Math.max(0, 1 - (now - this._stopFadeStartedAt) / this._stopFadeDuration)
          : 1;
        const startGain = previousFadeActive ? this._stopFadeStartGain * previousFadeFraction : g.value;
        g.cancelScheduledValues(now);
        g.setValueAtTime(startGain, now);
        g.linearRampToValueAtTime(0, now + fade);
        this._stopFadeStartGain = startGain;
      } catch {}

      this._stopPendingUntil = now + fade;
      this._stopFadeStartedAt = now;
      this._stopFadeDuration = fade;

      this._stopFinishTimer = setTimeout(() => {
        // Finalize stop
        Object.values(this.activeClips).forEach(({ source }) => {
          try { source && source.stop(); } catch {}
        });
        // Now that we’re truly stopped, kill any lingering timeouts (future transitions)
        this.clearScheduled();

        this.activeClips = {};
        this.lastPlayingClipName = null;
        this._isPreloaded = false;
        this.isPaused = false;
        this.pausedInfo = null;

        // Restore master to userGain for the next start
        try {
          this.masterGain.gain.cancelScheduledValues(ctx.currentTime);
          this.masterGain.gain.setValueAtTime(this.userGain, ctx.currentTime);
        } catch {}

        this._stopPendingUntil = 0;
        this._stopFadeStartedAt = 0;
        this._stopFadeDuration = 0;
        this._stopFadeStartGain = 0;
        this._stopFinishTimer = null;
        this.onStatus?.("Stopped");
      }, fade * 1000 + 50);
    } else {
      // Instant stop: stop sources and clear schedules
      Object.values(this.activeClips).forEach(({ source }) => {
        try { source && source.stop(); } catch {}
      });
      this.clearScheduled();
      this.activeClips = {};
      this.lastPlayingClipName = null;
      this._isPreloaded = false;
      this.isPaused = false;
      this.pausedInfo = null;
      try {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.userGain, now);
      } catch {}
      this._stopPendingUntil = 0;
      this._stopFadeStartedAt = 0;
      this._stopFadeDuration = 0;
      this._stopFadeStartGain = 0;
      this._stopFinishTimer = null;
      this.onStatus?.("Stopped");
    }
  }

  cancelStopFade() {
    if (!this.audioCtx || !this.masterGain || !this._stopFinishTimer) return false;
    const now = this.audioCtx.currentTime;
    if (!this._stopPendingUntil || now >= this._stopPendingUntil) return false;

    clearTimeout(this._stopFinishTimer);
    this._stopFinishTimer = null;

    const elapsed = Math.max(0, now - (this._stopFadeStartedAt || now));
    const duration = Math.max(0.06, Math.min(this._stopFadeDuration || elapsed || 0.06, elapsed || 0.06));
    const gain = this.masterGain.gain;
    try {
      if (typeof gain.cancelAndHoldAtTime === "function") {
        gain.cancelAndHoldAtTime(now);
      } else {
        const total = Math.max(0.001, this._stopFadeDuration || 0.001);
        const estimated = this._stopFadeStartGain * Math.max(0, 1 - (elapsed / total));
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(estimated, now);
      }
      gain.linearRampToValueAtTime(this.userGain ?? 1, now + duration);
    } catch {}

    this._stopPendingUntil = 0;
    this._stopFadeStartedAt = 0;
    this._stopFadeDuration = 0;
    this._stopFadeStartGain = 0;
    return true;
  }

  _fadeOutAndStopClip(name, durSec = 0.03) {
    const entry = this.activeClips?.[name];
    if (!entry || !entry.source || !entry.gainNode || !this.audioCtx) return;
    const t = this.audioCtx.currentTime;
    try {
      entry.gainNode.gain.cancelScheduledValues(t);
      // Preserve current level to ramp from:
      const current = entry.gainNode.gain.value ?? 1;
      entry.gainNode.gain.setValueAtTime(current, t);
      entry.gainNode.gain.linearRampToValueAtTime(0, t + durSec);
      entry.source.stop(t + durSec + 0.02);
    } catch {}
  }

  // ----- sections / modes -----
  playSection(sectionName) {
    console.log("[ENGINE] playSection", sectionName,
            "currentMode:", this.currentModeName);
    const section = this.sectionData[sectionName];
    if (!section) {
      console.error(`Section '${sectionName}' not found`);
      return;
    }

    // Determine starting mode for the target section:
    // default to base; if the section supports the *current* mode, keep it
    const available = this.getAvailableModes(sectionName);
    const keepMode = available.includes(this.currentModeName) ? this.currentModeName : "base";
    this.currentModeName = keepMode;
    this.onModeChange?.(keepMode);

    this.setCurrentSection(sectionName);
    this.playClip(section.firstClip);
  }

  queueSectionTransition(name) {
    this.queuedNextSectionName = name || null;
    this.onQueueChange?.(this.queuedNextSectionName);
  }
  clearQueuedSection() {
    this.queuedNextSectionName = null;
    this.onQueueChange?.(null);
  }

  // Helper: which section does a clip belong to? (prefix before first "_")
  _sectionOfClip(clipName) {
    const idx = clipName.indexOf("_");
    return idx === -1 ? clipName : clipName.slice(0, idx);
  }

  // ----- core playback -----
  playClip = (clipName, opts = {}) => {
    if (this.audioCtx && this.audioCtx.state !== "running") {
      if (this._rngDebug) console.warn("[ENGINE] playClip ignored: AudioContext suspended");
      return;
    }
    const { offsetSeconds = null } = opts || {};
    console.log("[ENGINE] playClip", clipName,
                "mode:", this.currentModeName, "section:", this.currentSectionName);
    const ctx = this.ensureContext();
    const clip = this.clipData[clipName];
    const entry = this.activeClips[clipName];
    if (!clip || !entry) {
      console.error(`Clip '${clipName}' not found or not loaded`);
      return;
    }

    // choose buffer by mode (fallback base)
    const mode = this.currentModeName || "base";
    const buffer =
      entry.buffersByMode?.[mode] ??
      entry.buffersByMode?.base;

    if (!buffer) {
      console.error(`No buffer for clip '${clipName}' in mode '${mode}' (or base)`, {
        clipName, mode, availableModes: Object.keys(entry.buffersByMode || {})
      });
      return;
    }

    // stop old instance for this clip
    if (entry.source) {
      try { entry.source.stop(); } catch {}
    }

    // if we had a warm-started muted node, clear it (we’ll start a fresh, exact node)
    this._clearWarmStart();

    this._playbackToken++;
    const myToken = this._playbackToken;

    const now = ctx.currentTime;

    // Build source + gain
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const hasNextInClip = Array.isArray(clip.nextClip) && clip.nextClip.length > 0;

    // Dynamic tracks: do NOT loop the node — scheduler handles transitions.
    // Simple (perma-loop) tracks can be handled later as a special case.
    source.loop = false;
    source.loopStart = 0;
    source.loopEnd  = buffer.duration;


    const gainNode = ctx.createGain();

    // apply trackVolume * userVolume (masterGain already applies user; keep trackVolume here)
    const startGain = 0;
    gainNode.gain.setValueAtTime(startGain, now);

    source.connect(gainNode);
    gainNode.connect(this.masterGain || this.audioCtx.destination);
    const startOffset = (offsetSeconds != null) ? offsetSeconds : (clip.loopStart || 0);
    source.start(0, startOffset);

    // store entry
    entry.source = source;
    entry.gainNode = gainNode;
    entry.startedAt = now;
    entry.offsetAtStart = startOffset;

    const targetGain = (typeof this.trackVolume === "number" ? this.trackVolume : 1);

    // Always start by cancelling any old automation
    gainNode.gain.cancelScheduledValues(now);

    /**
     * Fade policy:
     * - Resume(simple):    fade-in over pauseFadeSeconds  (opts.usePauseFade === true)
     * - Resume(complex):   immediate (opts.skipFadeIn === true)
     * - Normal starts / transitions: immediate (no fade)
     */
    if (opts.usePauseFade) {
      // Resume from pause on a simple track — do a symmetric fade-in
      gainNode.gain.setValueAtTime(0, now);
      const fadeInDur = Math.max(1, this.pauseFadeSeconds);
      gainNode.gain.linearRampToValueAtTime(targetGain, now + fadeInDur);
    } else {
      // All other paths: micro fade-in to avoid zipper/clicks
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(targetGain, now + 0.01);
    }

    // Record timing for progress + subsequent pauses
    const startedAt = now;
    const offsetAtStart = startOffset; // whatever you named the computed start offset

    // Keep buffer references consistent
    // If you support per-mode buffers (e.g., entry.buffersByMode), also keep entry.buffer for generic reads.
    this.activeClips[clipName] = {
      source,
      gainNode,
      buffer,          // retain classic field
      buffersByMode: entry.buffersByMode || undefined,
      startedAt,
      offsetAtStart
    };

    // Emit status and remember last playing clip
    this.onStatus?.(`Playing: ${clipName}`);
    this.lastPlayingClipName = clipName;

    // --- Auto section behavior: if this section is "auto" and this clip self-loops,
    // queue the next section now, so the scheduler will switch at loopPoint.
    const currSection = this.sectionData[this.currentSectionName];
    if (currSection?.type === "auto") {
      const ns = currSection.nextSection;
      const targets = Array.isArray(ns) ? ns : (ns ? [ns] : []);
      if (targets.length) {
        const selfLoops = Array.isArray(clip.nextClip) && clip.nextClip.includes(clipName);
        if (selfLoops) {
          const chosen = targets[0]; // pick the first if multiple
          if (chosen && this.queuedNextSectionName !== chosen) {
            this.queueSectionTransition(chosen); // updates queued state & notifies UI
          }
        }
      }
    }

    // unified scheduler at loopPoint: handle (1) queued section, (2) queued mode, (3) clip.nextClip
    const timeUntilLoopPoint = (clip.loopPoint ?? buffer.duration) - startOffset;
    if (timeUntilLoopPoint > 0) {
      const id = setTimeout(() => {
        // If a newer playClip has started since this timer was set, abort.
        if (myToken !== this._playbackToken) {
          // stale timer; do nothing
          return;
        }
        const now2 = ctx.currentTime;

        this._handleLoopPointForClip(clipName);

        // fade remainder to 0 at clipEnd
        const clipEndTime = clip.clipEnd ?? buffer.duration;
        const delta = clipEndTime - (clip.loopPoint ?? buffer.duration);
        gainNode.gain.setValueAtTime(0, now2 + Math.max(0, delta));
      }, timeUntilLoopPoint * 1000);
      this.scheduledTimeouts.push(id);
    }

    // Stop the source at clipEnd (one-shot safety)
    const endAtSec = (clip.clipEnd ?? buffer.duration);
    const stopSpan = Math.max(0, endAtSec - startOffset);
    if (stopSpan > 0) {
      const idStop = setTimeout(() => {
        try { source.stop(); } catch {}
      }, stopSpan * 1000 + 10);
      this.scheduledTimeouts.push(idStop);
    }


    // true end detection for "end" sections: when last clip has no nextClip
    const section = this.sectionData[this.currentSectionName];
    if (!hasNextInClip && section?.type === "end") {
      const tail = (clip.clipEnd ?? buffer.duration) - startOffset;
      const id2 = setTimeout(() => this._hardStopAtEnd(), tail * 1000);
      this.scheduledTimeouts.push(id2);
    }
  }

  /**
   * Start a clip at a specific AudioContext time with an offset.
   * Sample-accurate; no reliance on JS timers for the onset.
   */
  _playClipAtAudioTime(clipName, { modeName = "base", offsetSeconds = 0, startAtAudioTime } = {}) {
    const ctx = this.ensureContext();
    const entry = this.activeClips?.[clipName];
    if (!entry) return;

    const mode = modeName || this.currentModeName || "base";
    const buffer = entry.buffersByMode?.[mode] ?? entry.buffer;
    if (!buffer) return;

    // Kill any existing instance of this clip
    if (entry.source) { try { entry.source.stop(); } catch {} }

    // Build nodes
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // One-shot: no node-level looping for dynamic tracks
    src.loop = false;
    src.loopStart = 0;
    src.loopEnd  = buffer.duration;


    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, startAtAudioTime); // start muted; we’ll ramp
    src.connect(gainNode);
    gainNode.connect(this.masterGain || ctx.destination);

    // Bookkeeping for progress and loop scheduling
    entry.source = src;
    entry.gainNode = gainNode;
    entry.startedAt = startAtAudioTime;
    entry.offsetAtStart = Math.max(0, Number(offsetSeconds) || 0);

    // Compute target track gain (respects current trackVolume)
    const targetGain = this.trackVolume ?? 1;

    // Schedule gain unmute (tiny ramp to avoid click)
    const rampEnd = startAtAudioTime + 0.01;
    gainNode.gain.setValueAtTime(0, startAtAudioTime);
    gainNode.gain.linearRampToValueAtTime(targetGain, rampEnd);

    // Start the source at precise audio time & offset
    src.start(startAtAudioTime, entry.offsetAtStart);

    const loopPoint = this.clipData[clipName]?.loopPoint ?? buffer.duration;
    const spanToLoop = Math.max(0, loopPoint - entry.offsetAtStart);

    // We scheduled the audible start at `startAtAudioTime` (in the future).
    // The loop timer must include the lead time until that moment.
    const nowCtx = ctx.currentTime;
    const leadSec = Math.max(0, startAtAudioTime - nowCtx);
    const msUntilLoop = Math.max(0, (leadSec + spanToLoop) * 1000);

    if (entry.timerId != null) { try { clearTimeout(entry.timerId); } catch {} }
    entry.timerId = setTimeout(() => {
      this._handleLoopPointForClip(clipName);
    }, msUntilLoop);

    // NEW: stop this source at its true clipEnd
    const clipEnd = (this.clipData[clipName]?.clipEnd ?? buffer.duration);
    // time remaining from our scheduled start to clipEnd:
    const spanToEnd = Math.max(0, clipEnd - entry.offsetAtStart);
    const msUntilEnd = Math.max(0, (leadSec + spanToEnd) * 1000);
    const stopId = setTimeout(() => {
      try { src.stop(); } catch {}
    }, msUntilEnd + 10);
    this.scheduledTimeouts.push(stopId);

    // Update current pointers & status
    this.lastPlayingClipName = clipName;
    this.currentSectionName = this.currentSectionName || this._computeDefaultStartSection();
    this.currentModeName = mode;
    this.onStatus?.(`Playing: ${clipName}`);
  }

  _isAutoSectionTransitionPending(sectionName) {
    const s = this.sectionData?.[sectionName];
    if (!s) return false;
    // Try a few conventional keys; customize if your schema differs
    return s.type === "auto" && !!s.nextSection;
  }

  _stopAllExcept(keepClipName) {
    if (!this.activeClips) return;
    for (const [name, entry] of Object.entries(this.activeClips)) {
      if (name === keepClipName) continue;
      try {
        if (entry?.source) {
          // Hard stop; we don't need old tails on a late join.
          entry.source.stop();
          entry.source.disconnect?.();
          entry.source = null;
        }
        if (entry?.gainNode) {
          entry.gainNode.disconnect?.();
          entry.gainNode = null;
        }
        entry.timerId && clearTimeout(entry.timerId);
        entry.timerId = null;
      } catch {}
    }
  }

  pause(simpleTrack = true) {
    if (!this.audioCtx || !this.lastPlayingClipName) return;
    if (this.isPaused) return;

    const ctx = this.audioCtx;
    const fade = Math.max(1, Number(this.pauseFadeSeconds || 1));
    const entry = this.activeClips[this.lastPlayingClipName];
    if (!entry || !entry.gainNode || !entry.source) return;

    if (!simpleTrack) {
      // Complex: stop further transitions *immediately*
      this.clearScheduled();
    }

    const now = ctx.currentTime;
    try {
      const g = entry.gainNode.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fade);
    } catch {}

    this._pauseFinishTimer = setTimeout(() => {
      this._pauseFinishTimer = null;
      // Compute offset at fade end (simple only)
      let offsetSeconds = null;
      if (simpleTrack) {
        const clipName = this.lastPlayingClipName;
        const buff = this._bufferForClipMode(clipName);
        if (buff) {
          const elapsed = Math.max(0, (ctx.currentTime - entry.startedAt));
          const rawPos = (entry.offsetAtStart || 0) + elapsed;
          const dur = Math.max(1e-6, buff.duration);
          offsetSeconds = ((rawPos % dur) + dur) % dur; // [0,dur)
        }
      }

      try { entry.source.stop(); } catch {}

      this.isPaused = true;
      this.pausedInfo = { clipName: this.lastPlayingClipName, offsetSeconds };
      this.onStatus?.("Paused");
    }, fade * 1000 + 20);
  }

  resume(simpleTrack = true) {
    if (!this.isPaused || !this.pausedInfo) return;
    const { clipName, offsetSeconds } = this.pausedInfo;

    // If buffers are gone, just unpause
    if (!this.clipData[clipName] || !this.activeClips[clipName]) {
      this.isPaused = false;
      this.pausedInfo = null;
      return;
    }

    const opts = simpleTrack
      ? { offsetSeconds: offsetSeconds ?? null, skipFadeIn: false, usePauseFade: true }
      : { offsetSeconds: null, skipFadeIn: true, usePauseFade: false }; // restart from beginning, no fade-in

    if (simpleTrack) {
      console.log("[RESUME simple] offsetSeconds:", offsetSeconds, "fade:", this.pauseFadeSeconds);
    } else {
      console.log("[RESUME complex] restart from beginning (no fade-in)");
    }

    this.playClip(clipName, opts);

    this.isPaused = false;
    this.pausedInfo = null;
  }

  _playableDuration(clipName, buffer) {
    const clip = this.clipData?.[clipName];
    if (!clip || !buffer) return 0;
    const metadataDuration = Number(clip.loopPoint ?? clip.clipEnd);
    const bufferDuration = Math.max(0, Number(buffer.duration) || 0);
    if (!Number.isFinite(metadataDuration) || metadataDuration <= 0) return bufferDuration;
    return bufferDuration > 0 ? Math.min(metadataDuration, bufferDuration) : metadataDuration;
  }

  seekSimpleTrack(positionSeconds) {
    if (this.trackData?.[this.currentTrackName]?.simple !== true) return false;
    const clipName = this.pausedInfo?.clipName || this.lastPlayingClipName;
    const entry = clipName ? this.activeClips?.[clipName] : null;
    const buffer = clipName ? (this._bufferForClipMode(clipName) || entry?.buffer) : null;
    const duration = this._playableDuration(clipName, buffer);
    if (!clipName || !entry || duration <= 0) return false;

    const requested = Math.max(0, Number(positionSeconds) || 0);
    const offsetSeconds = Math.min(requested, Math.max(0, duration - 0.001));
    if (this.isPaused && this.pausedInfo) {
      this.pausedInfo = { ...this.pausedInfo, clipName, offsetSeconds };
      return true;
    }

    this.clearScheduled();
    this.playClip(clipName, { offsetSeconds, skipFadeIn: true });
    return true;
  }

  getPlaybackInfo() {
    // If we paused and captured an offset, keep the bar frozen at that location.
    if (this.isPaused && this.pausedInfo) {
      const { clipName, offsetSeconds } = this.pausedInfo;
      const clip = this.clipData?.[clipName];
      const buff = this._bufferForClipMode?.(clipName) || this.activeClips?.[clipName]?.buffer;
      if (clip && buff) {
        const loopStart = clip.loopStart || 0;
        const loopPoint = (clip.loopPoint ?? buff.duration);
        const span = Math.max(1e-6, loopPoint - loopStart);
        const offset = (offsetSeconds != null) ? offsetSeconds : loopStart;
        const rel = Math.max(0, Math.min(1, (offset - loopStart) / span));
        const durationSeconds = this._playableDuration(clipName, buff);
        return { progress01: rel, positionSeconds: Math.max(0, offset), durationSeconds };
      }
      return { progress01: 0, positionSeconds: 0, durationSeconds: 0 };
    }

    // Normal running path
    const clipName = this.lastPlayingClipName;
    const entry = clipName ? this.activeClips?.[clipName] : null;
    const clip  = clipName ? this.clipData?.[clipName] : null;
    const buff  = this._bufferForClipMode?.(clipName) || entry?.buffer;
    const ctx   = this.audioCtx;

    if (!ctx || !entry || !clip || !buff) return { progress01: 0, positionSeconds: 0, durationSeconds: 0 };

    const loopStart = clip.loopStart || 0;
    const loopPoint = (clip.loopPoint ?? buff.duration);
    const span = Math.max(1e-6, loopPoint - loopStart);

    // Estimate current playhead (offsetAtStart + elapsed)
    const elapsed = Math.max(0, (ctx.currentTime - entry.startedAt));
    const pos = (entry.offsetAtStart || 0) + elapsed;

    // Map to 0..1 between loopStart..loopPoint (wrapping if necessary)
    const dur = Math.max(1e-6, buff.duration);
    const posWrapped = ((pos % dur) + dur) % dur;
    const clamped = Math.max(loopStart, Math.min(loopPoint, posWrapped));
    const rel = Math.max(0, Math.min(1, (clamped - loopStart) / span));

    return {
      progress01: rel,
      positionSeconds: Math.max(0, posWrapped),
      durationSeconds: this._playableDuration(clipName, buff),
    };
  }

  getTrackExitTiming() {
    const ctx = this.audioCtx;
    if (!ctx) return null;
    if (this._stopPendingUntil) {
      return {
        kind: "fade",
        remainingSeconds: Math.max(0, this._stopPendingUntil - ctx.currentTime),
        totalSeconds: this._stopFadeDuration,
      };
    }

    const clipName = this.lastPlayingClipName;
    const clip = this.clipData?.[clipName];
    const entry = this.activeClips?.[clipName];
    const buffer = entry?.buffer;
    if (!clip || !entry || !buffer) return null;
    const positionSeconds = this.isPaused && this.pausedInfo?.clipName === clipName
      ? this.pausedInfo.offsetSeconds
      : (entry.offsetAtStart || 0) + Math.max(0, ctx.currentTime - entry.startedAt);
    const boundary = clip.loopPoint ?? buffer.duration;
    return {
      kind: "clip",
      clipName,
      startedAt: entry.startedAt,
      positionSeconds,
      toBoundarySeconds: Math.max(0, boundary - positionSeconds),
    };
  }

  schedule(fn, atAudioTime) {
    const ctx = this.ensureContext();
    const ms = Math.max(0, (atAudioTime - ctx.currentTime) * 1000);
    const id = setTimeout(fn, ms);
    this.scheduledTimeouts.push(id);
  }

  _bufferForClipMode(clipName) {
    const entry = this.activeClips?.[clipName];
    if (!entry) return null;
    const mode = this.currentModeName || "base";
    // If you load per-mode buffers into entry.buffersByMode, select it; otherwise fall back to entry.buffer
    return entry.buffersByMode?.[mode] ?? entry.buffer ?? null;
  }

  // Accept both styles:
  // - "file": "Foo.ogg"                -> { base: "Foo.ogg" }
  // - "file": { base: "Foo.ogg", ... } -> unchanged
  _normalizeFileMap(fileField) {
    if (!fileField) return {};
    if (typeof fileField === "string") {
      return { base: fileField };
    }
    if (typeof fileField === "object") {
      return fileField;
    }
    console.warn("[ENGINE] Unexpected 'file' field type:", typeof fileField, fileField);
    return {};
  }

  // Pick a reasonable default section for warm-start: first key in sectionData
  _computeDefaultStartSection() {
    const names = Object.keys(this.sectionData || {});
    return names.length ? names[0] : null;
  }

  _createBufferForClipMode(clipName, modeName) {
    const entry = this.activeClips?.[clipName];
    if (!entry) return null;
    const mode = modeName || this.currentModeName || "base";
    return entry.buffersByMode?.[mode] ?? entry.buffer ?? null;
  }

  _startMutedClip(clipName, { modeName = "base", offsetSeconds = 0 } = {}) {
    const ctx = this.ensureContext();
    const buffer = this._createBufferForClipMode(clipName, modeName);
    if (!buffer) return null;
    // build nodes (directly into the always-zero warmBus)
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = (this.clipData[clipName]?.loopStart || 0);
    src.loopEnd  = (this.clipData[clipName]?.loopPoint ?? buffer.duration);
    // Route to warmBus so it can never be heard
    src.connect(this.warmBus);
    try { src.start(0, Math.max(0, offsetSeconds)); } catch {}
    return { source: src };
  }

  _clearWarmStart() {
    const ws = this._warmStart;
    if (!ws) return;
    try { ws.timerId != null && clearTimeout(ws.timerId); } catch {}
    try { ws.source?.stop(); } catch {}
    this._warmStart = null;
  }

  // A peekable mulberry32 that we can fast-forward without touching engine RNG
  _makePeekRng(seed, drawCount = 0) {
    const s0 = (Number(seed) >>> 0) || 1;
    let s = s0;
    const step = () => {
      let t = (s += 0x6D2B79F5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // fast-forward to drawCount
    for (let i = 0; i < (drawCount|0); i++) step();
    return { next: step, cloneAt: (n) => this._makePeekRng(seed, n) };
  }

  /**
   * Compute which clip/mode and offset will be playing after deltaSec,
   * given current position, queued section/mode, and seeded RNG.
   * Does not mutate engine state or engine RNG.
   */
  _computeFuturePosition({ deltaSec, sectionName, modeName, clipName, offsetSeconds, seed, rngDrawCount }) {
    const clipData = this.clipData;
    const sectionData = this.sectionData;
    if (!clipName || !clipData[clipName]) return null;
    let remaining = Math.max(0, Number(deltaSec) || 0);
    let sec = sectionName;
    let mode = modeName || "base";
    let clip = clipName;
    let offset = Math.max(0, Number(offsetSeconds) || 0);
    let draws = rngDrawCount | 0;
    const rng = this._makePeekRng(seed, draws);

    // consider one possible queued section at the first loop boundary only
    let allowSectionQueue = true;
    let queuedSec = this.queuedNextSectionName || null;
    let queuedMode = this.queuedNextModeName || null;

    for (let hop = 0; hop < 16 && remaining > 0; hop++) {
      const cd = clipData[clip]; if (!cd) break;
      const buffer = this._createBufferForClipMode(clip, mode) || this._createBufferForClipMode(clip, "base");
      if (!buffer) break;
      const loopStart = cd.loopStart || 0;
      const loopPoint = (cd.loopPoint ?? buffer.duration);
      const spanToLoop = Math.max(0, loopPoint - offset);
      if (remaining <= spanToLoop) {
        // still inside current clip at t+Δ
        return { sectionName: sec, modeName: mode, clipName: clip, offsetSeconds: offset + remaining, rngDrawCount: draws };
      }
      // cross a boundary
      remaining -= spanToLoop;
      offset = loopStart; // next clip starts at its loopStart

      // section change takes precedence once, at the boundary
      if (allowSectionQueue && queuedSec) {
        const nextSection = sectionData[queuedSec];
        const nextClip = nextSection?.firstClip;
        sec = queuedSec;
        // compute mode for new section: keep current if allowed else base; apply queuedMode if provided and valid
        let nextMode = mode;
        const modesAvail = this.getAvailableModes(sec);
        if (!modesAvail.includes(nextMode)) nextMode = "base";
        if (queuedMode && modesAvail.includes(queuedMode)) nextMode = queuedMode;
        mode = nextMode;
        clip = nextClip || clip; // if section missing, fallback
        // after switching sections once, ignore further section queues in this look-ahead
        allowSectionQueue = false;
        queuedSec = null; // consumed
        continue;
      }

      // no section change → normal nextClip path (respect queued mode at boundary)
      if (queuedMode) {
        const modesAvail = this.getAvailableModes(sec);
        if (modesAvail.includes(queuedMode)) mode = queuedMode;
        queuedMode = null;
      }
      const arr = Array.isArray(cd.nextClip) ? cd.nextClip : [];
      if (!arr.length) {
        // no next → stay on this clip (loops itself to clipEnd)
        return { sectionName: sec, modeName: mode, clipName: clip, offsetSeconds: offset, rngDrawCount: draws };
      }
      const arr2 = arr.length > 1 ? [...arr].sort() : arr;
      clip = chooseNextClip(arr2, () => { draws += 1; return rng.next(); });
      // loop: continue with new clip & same mode
    }
    // fallback if loop exits
    return { sectionName: sec, modeName: mode, clipName: clip, offsetSeconds: offset, rngDrawCount: draws };
  }

  getAudioState() {
    return this.audioCtx?.state || "suspended";
  }

  /** Returns a promise that resolves once the context is running. */
  unlockAudio = () => {
    const ctx = this.ensureContext();
    if (ctx.state === "running") return Promise.resolve();

    return new Promise((resolve) => {
      const tryResume = async () => {
        try { await ctx.resume(); } catch {}
        if (ctx.state === "running") {
          cleanup();
          resolve();
        }
      };
      const onUserGesture = () => { tryResume(); };
      const onVis = () => { if (document.visibilityState === "visible") tryResume(); };

      const cleanup = () => {
        window.removeEventListener("pointerdown", onUserGesture, true);
        window.removeEventListener("keydown", onUserGesture, true);
        window.removeEventListener("touchstart", onUserGesture, true);
        document.removeEventListener("visibilitychange", onVis, true);
      };

      window.addEventListener("pointerdown", onUserGesture, true);
      window.addEventListener("keydown", onUserGesture, true);
      window.addEventListener("touchstart", onUserGesture, true);
      document.addEventListener("visibilitychange", onVis, true);

      // Also try immediately in case a prior gesture already occurred
      tryResume();
    });
  };
}

function mulberry32(a) {
  return function() {
    let t = (a += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
