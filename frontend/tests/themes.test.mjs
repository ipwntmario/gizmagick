import assert from 'node:assert/strict';
import test from 'node:test';
import { availableThemes, resolveTheme, themeStorageKey } from '../src/themes.js';

test('each session starts with its own default and stores a separate choice', () => {
  assert.equal(resolveTheme('', null).id, 'dark');
  assert.equal(resolveTheme('awc', null).id, 'castle-torchlit');
  assert.equal(resolveTheme('cyberspace-club', null).id, 'h4ck3r');
  assert.equal(resolveTheme('awc', 'book1').id, 'signet');
  assert.equal(resolveTheme('', 'hogwarts').id, 'castle-torchlit');
  assert.equal(resolveTheme('', 'four-houses').id, 'castle-torchlit');
  assert.notEqual(themeStorageKey(''), themeStorageKey('awc'));
  assert.notEqual(themeStorageKey('awc'), themeStorageKey('cyberspace-club'));
});

test('every session can use every theme', () => {
  const themeIds = ['dark', 'high-contrast', 'light', 'high-contrast-light', 'signet', 'castle-torchlit', 'h4ck3r'];
  for (const roomId of ['', 'awc', 'cyberspace-club', 'future-room']) {
    assert.deepEqual(availableThemes(roomId).map(({ id }) => id), themeIds);
    assert.equal(resolveTheme(roomId, 'castle-torchlit').id, 'castle-torchlit');
    assert.equal(resolveTheme(roomId, 'high-contrast-light').id, 'high-contrast-light');
    assert.equal(resolveTheme(roomId, 'h4ck3r').id, 'h4ck3r');
  }
  assert.deepEqual(availableThemes().map(({ group }) => group), ['Standard', 'Standard', 'Standard', 'Standard', 'Fantasy', 'Fantasy', 'Tech']);
});

test('fantasy and tech themes provide their own cursor effects', () => {
  assert.deepEqual(availableThemes().map(({ cursorEffect }) => cursorEffect ?? null), [null, null, null, null, 'wand', 'wand', 'terminal']);
});
