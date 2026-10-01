import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTrackDuration, trackDurationSeconds } from '../src/data/trackDuration.js';
import { orderTracks } from '../src/data/trackOrdering.js';

test('simple duration uses the clip end, while dynamic duration sums loop points once', () => {
  const clips = {
    intro: { loopPoint: 8, clipEnd: 12 },
    loop: { loopPoint: 15, clipEnd: 20 },
  };
  assert.equal(trackDurationSeconds({ simple: true }, { intro: clips.intro }), 12);
  assert.equal(trackDurationSeconds({ simple: false }, clips), 23);
  assert.equal(formatTrackDuration(75.7), '1:16');
  assert.equal(formatTrackDuration(null), '—');
});

test('duration sorting respects direction, pinned tracks, and missing metadata', () => {
  const tracks = { A: {}, B: {}, C: {}, D: {} };
  const durations = { A: 60, B: 20, C: 120 };
  const pinned = new Set(['C']);
  assert.deepEqual(orderTracks(tracks, { sortMode: 'duration-asc', durations, pinned }), ['C', 'B', 'A', 'D']);
  assert.deepEqual(orderTracks(tracks, { sortMode: 'duration-desc', durations, pinned }), ['C', 'A', 'B', 'D']);
});
