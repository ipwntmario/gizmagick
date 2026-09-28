import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesTrackSearch } from '../src/data/trackSearch.js';

test('track search finds partial names, spaced terms, and initials', () => {
  assert.equal(matchesTrackSearch('moth', 'Follow the Moth'), true);
  assert.equal(matchesTrackSearch('follow moth', 'Follow the Moth'), true);
  assert.equal(matchesTrackSearch('ftm', 'Follow the Moth'), true);
  assert.equal(matchesTrackSearch('tower', 'Follow the Moth'), false);
});

test('track search tolerates one typo and can find a renamed track by its original name', () => {
  assert.equal(matchesTrackSearch('haert', 'Hearth'), false);
  assert.equal(matchesTrackSearch('haerth', 'Hearth'), true);
  assert.equal(matchesTrackSearch('hearrh', 'Hearth'), true);
  assert.equal(matchesTrackSearch('moth', 'Night Flight', 'Follow the Moth'), true);
  assert.equal(matchesTrackSearch('', 'Anything'), true);
});
