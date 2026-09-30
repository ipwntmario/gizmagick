import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio/audioEngine.js';
import { orderTracks } from '../src/data/trackOrdering.js';
import { findSelectableEndSection } from '../src/data/sectionTransitions.js';

test('track replacement chooses only an end section available from the current buttons', () => {
  const sections = {
    Main: { nextSection: ['Bridge', 'End'] },
    Bridge: { nextSection: ['Main'] },
    AutoBridge: { type: 'auto', nextSection: 'End' },
    End: { type: 'end' },
  };
  assert.equal(findSelectableEndSection(sections, 'Main'), 'End');
  assert.equal(findSelectableEndSection(sections, 'Bridge'), null);
  assert.equal(findSelectableEndSection(sections, 'AutoBridge'), null);
  assert.equal(findSelectableEndSection(sections, 'End'), null);
});

function fixture() {
  const engine = new AudioEngine();
  const parameter = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
  engine.audioCtx = {
    state: 'running', currentTime: 1,
    createGain: () => ({ gain: parameter(), connect() {} }),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {} }),
  };
  engine.masterGain = engine.audioCtx.createGain();
  engine.warmBus = engine.audioCtx.createGain();
  engine.setData({
    clips: {
      A: { nextClip: ['B'], loopPoint: 10, clipEnd: 11 },
      B: { nextClip: ['D', 'C'], loopPoint: 10, clipEnd: 11 },
      C: { nextClip: ['A'], loopPoint: 10, clipEnd: 11 },
      D: { nextClip: ['A'], loopPoint: 10, clipEnd: 11 },
    },
    sections: { Main: { firstClip: 'A', modes: ['intense'] }, Next: { firstClip: 'D' } },
    tracks: {},
  });
  for (const name of Object.keys(engine.clipData)) engine.activeClips[name] = { buffersByMode: { base: { duration: 11 }, intense: { duration: 11 } } };
  engine.setCurrentSection('Main');
  engine.setRandomSeed(42);
  return engine;
}

function withTimers(fn) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let serial = 0;
  globalThis.setTimeout = (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  try { return fn(timers); } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
}

test('normal and scheduled playback consume identical RNG draws at boundaries', () => withTimers(timers => {
  const normal = fixture();
  normal.playClip('A');
  const normalBoundary = [...timers.values()].find(timer => timer.ms === 10000);
  normalBoundary.callback();
  assert.equal(normal.lastPlayingClipName, 'B');
  assert.equal(normal.getRngDrawCount(), 0);
  normal._handleLoopPointForClip('B');
  const expected = normal.lastPlayingClipName;
  assert.equal(normal.getRngDrawCount(), 1);
  timers.clear();
  const scheduled = fixture();
  scheduled._playClipAtAudioTime('A', { startAtAudioTime: 1 });
  timers.get(scheduled.activeClips.A.timerId).callback();
  assert.equal(scheduled.lastPlayingClipName, 'B');
  assert.equal(scheduled.getRngDrawCount(), 0);
  scheduled._handleLoopPointForClip('B');
  assert.equal(scheduled.lastPlayingClipName, expected);
  assert.equal(scheduled.getRngDrawCount(), 1);
}));

test('section changes preserve compatible modes and clear both UI queues', () => withTimers(() => {
  const engine = fixture();
  const queues = [];
  engine.onQueueChange = value => queues.push(['section', value]);
  engine.onModeQueueChange = value => queues.push(['mode', value]);
  engine.setCurrentMode('intense');
  engine.queueSectionTransition('Next');
  engine.queueModeTransition('intense');
  engine._handleLoopPointForClip('A');
  assert.equal(engine.currentSectionName, 'Next');
  assert.equal(engine.currentModeName, 'base');
  assert.equal(engine.lastPlayingClipName, 'D');
  assert.deepEqual(queues.slice(-2), [['section', null], ['mode', null]]);
}));

test('stop cancels scheduled-position transitions', () => withTimers(timers => {
  const engine = fixture();
  engine._playClipAtAudioTime('A', { startAtAudioTime: 2 });
  const boundaryId = engine.activeClips.A.timerId;
  engine.stopTrack(false);
  assert.equal(timers.has(boundaryId), false);
  assert.equal(engine.isPlaying, false);
}));

test('switching sessions silences playback without reporting a stop', () => withTimers(timers => {
  const engine = fixture();
  const statuses = [];
  let stopped = 0;
  engine.onStatus = status => statuses.push(status);
  engine.activeClips.A.source = { stop() { stopped += 1; } };
  engine.lastPlayingClipName = 'A';
  engine.currentTrackName = 'Old room track';
  engine._isPreloaded = true;
  engine.queuedNextSectionName = 'Next';
  engine.stopTrack(true);
  const stopTimer = engine._stopFinishTimer;

  engine.resetForSession();

  assert.equal(stopped, 1);
  assert.equal(timers.has(stopTimer), false);
  assert.equal(engine.currentTrackName, null);
  assert.equal(engine.isPlaying, false);
  assert.equal(engine.isPreloaded, false);
  assert.equal(engine.queuedNextSectionName, null);
  assert.deepEqual(statuses, []);
}));

test('a preload from the old session cannot restore its track', async () => {
  const engine = fixture();
  const statuses = [];
  engine.onStatus = status => statuses.push(status);
  engine.setData({ clips: { A: { file: 'a.ogg' } }, sections: {}, tracks: {} });
  let finishDecode;
  engine._loadBufferWithCache = () => new Promise(resolve => { finishDecode = resolve; });

  const preload = engine.preloadTrack('Old room track');
  engine.resetForSession();
  finishDecode({ duration: 10 });
  await preload;

  assert.equal(engine.currentTrackName, null);
  assert.equal(engine.isPreloaded, false);
  assert.deepEqual(engine.activeClips, {});
  assert.deepEqual(statuses, []);
});

test('a pending stop fade can be reversed before it completes', () => withTimers(timers => {
  const engine = fixture();
  const ramps = [];
  let heldAt = null;
  engine.lastPlayingClipName = 'A';
  engine.masterGain.gain = {
    value: 1,
    cancelScheduledValues() {},
    cancelAndHoldAtTime(time) { heldAt = time; },
    setValueAtTime() {},
    linearRampToValueAtTime(value, time) { ramps.push({ value, time }); },
  };
  engine.setFadeOutSeconds(6);
  engine.stopTrack(true);
  assert.equal(timers.size > 0, true);

  engine.audioCtx.currentTime = 3;
  assert.equal(engine.cancelStopFade(), true);
  assert.equal(heldAt, 3);
  assert.deepEqual(ramps.at(-1), { value: 1, time: 5 });
  assert.equal(engine._stopPendingUntil, 0);
  assert.equal(engine._stopFinishTimer, null);
  assert.equal(engine.isPlaying, true);
}));

test('changing tracks releases the previous decoded buffer cache', async () => {
  const engine = fixture();
  engine.currentTrackName = 'Old';
  engine._bufferCache.set('old.ogg', {});
  engine.setData({ clips: {}, sections: {}, tracks: {} });
  await engine.preloadTrack('New');
  assert.equal(engine.currentTrackName, 'New');
  assert.equal(engine._bufferCache.size, 0);
});

test('queued tracks decode into cache without replacing live playback data', async () => {
  const engine = fixture();
  engine.currentTrackName = 'Live';
  engine.lastPlayingClipName = 'A';
  const originalClips = engine.clipData;
  const loaded = [];
  engine._loadBufferWithCache = async (url, _context, meta) => {
    loaded.push({ url, meta });
    engine._bufferCache.set(url, {});
  };

  await engine.cacheTrackBuffers('Queued', {
    Q: { file: { base: 'quiet song.ogg', intense: 'loud&fast.ogg' } },
  }, { basePath: '/tracks/Queued Track' });

  assert.equal(engine.currentTrackName, 'Live');
  assert.equal(engine.lastPlayingClipName, 'A');
  assert.equal(engine.clipData, originalClips);
  assert.deepEqual(loaded.map(entry => entry.url), [
    '/tracks/Queued%20Track/audio/quiet%20song.ogg',
    '/tracks/Queued%20Track/audio/loud%26fast.ogg',
  ]);
});

test('activating a queued track reuses its decoded buffers and prunes stale cache entries', async () => {
  const engine = fixture();
  engine.lastPlayingClipName = null;
  engine.currentTrackName = 'Old';
  engine.trackBase = '/tracks/Queued';
  engine.setData({ clips: { Q: { file: 'ready.ogg' } }, sections: {}, tracks: {} });
  const readyBuffer = { duration: 5 };
  engine._bufferCache.set('/tracks/Queued/audio/ready.ogg', readyBuffer);
  engine._bufferCache.set('/tracks/Old/audio/stale.ogg', {});

  await engine.preloadTrack('Queued', { basePath: '/tracks/Queued', preserveCache: true });

  assert.equal(engine.activeClips.Q.buffersByMode.base, readyBuffer);
  assert.deepEqual([...engine._bufferCache.keys()], ['/tracks/Queued/audio/ready.ogg']);
});

test('simple tracks expose a timeline and can seek while playing or paused', () => withTimers(() => {
  const engine = fixture();
  engine.trackData = { Simple: { simple: true } };
  engine.currentTrackName = 'Simple';
  engine.playClip('A');
  engine.audioCtx.currentTime = 4;

  assert.deepEqual(engine.getPlaybackInfo(), {
    progress01: 0.3,
    positionSeconds: 3,
    durationSeconds: 10,
  });

  assert.equal(engine.seekSimpleTrack(7), true);
  assert.equal(engine.activeClips.A.offsetAtStart, 7);
  assert.equal(engine.getPlaybackInfo().positionSeconds, 7);

  engine.isPaused = true;
  engine.pausedInfo = { clipName: 'A', offsetSeconds: 7 };
  assert.equal(engine.seekSimpleTrack(4), true);
  assert.equal(engine.pausedInfo.offsetSeconds, 4);
  assert.equal(engine.getPlaybackInfo().positionSeconds, 4);
}));

test('catalog ordering respects filters even for pinned tracks and honors renamed titles', () => {
  const tracks = { A: { simple: true }, B: { simple: false }, C: { simple: false, test: true }, D: { test: true } };
  assert.deepEqual(orderTracks(tracks, { pinned: new Set(['C']), filters: { tests: 'exclude' }, sortMode: 'alpha-asc' }), ['A', 'B']);
  assert.deepEqual(orderTracks(tracks, { pinned: new Set(['C']), sortMode: 'alpha-desc' }), ['C', 'D', 'B', 'A']);
  assert.deepEqual(orderTracks({ A: {}, B: {} }, { names: { tracks: { A: { displayName: 'Z' } } }, sortMode: 'alpha-asc' }), ['B', 'A']);
});

test('track type and test status filters intersect independently', () => {
  const tracks = { dynamic: { simple: false }, dynamicTest: { simple: false, test: true }, simple: { simple: true }, simpleTest: { simple: true, test: true } };
  assert.deepEqual(orderTracks(tracks, { filters: { simple: false, tests: 'only' } }), ['dynamicTest']);
  assert.deepEqual(orderTracks(tracks, { filters: { dynamic: false, tests: 'only' } }), ['simpleTest']);
  assert.deepEqual(orderTracks(tracks, { filters: { tests: 'exclude' } }), ['dynamic', 'simple']);
  assert.deepEqual(orderTracks(tracks, { filters: { dynamic: false, simple: false } }), []);
  assert.equal(orderTracks(tracks, { filters: {} }).length, 4);
});
