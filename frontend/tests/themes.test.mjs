import assert from 'node:assert/strict';
import test from 'node:test';
import { THEMES, availableThemes, resolveTheme, themeStorageKey } from '../src/themes.js';

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
  const themeIds = ['dark', 'medium-contrast-dark', 'dark-magic-subtle', 'medium-contrast-dark-magic', 'high-contrast', 'light', 'medium-contrast-light', 'high-contrast-light', 'dark-magic', 'pink-splash', 'signet', 'pink-palace', 'castle-torchlit', 'h4ck3r'];
  for (const roomId of ['', 'awc', 'cyberspace-club', 'future-room']) {
    assert.deepEqual(availableThemes().map(({ id }) => id), themeIds);
    assert.equal(resolveTheme(roomId, 'castle-torchlit').id, 'castle-torchlit');
    assert.equal(resolveTheme(roomId, 'high-contrast-light').id, 'high-contrast-light');
    assert.equal(resolveTheme(roomId, 'h4ck3r').id, 'h4ck3r');
    assert.equal(resolveTheme(roomId, 'pink-palace').name, 'Pink Palace');
    assert.equal(resolveTheme(roomId, 'pink-splash').name, 'Pink Splash');
    assert.equal(resolveTheme(roomId, 'dark-magic').name, 'Dark Magic (Vibrant)');
    assert.equal(resolveTheme(roomId, 'dark-magic-subtle').name, 'Dark Magic');
  }
  assert.deepEqual(availableThemes().map(({ group }) => group), ['Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Fun', 'Fun', 'Fantasy', 'Fantasy', 'Fantasy', 'Tech']);
});

test('fantasy and tech themes provide their own cursor effects', () => {
  assert.deepEqual(availableThemes().map(({ cursorEffect }) => cursorEffect ?? null), [null, null, null, null, null, null, null, null, null, 'wand', 'wand', 'wand', 'wand', 'terminal']);
});

test('old themes are available only when the developer option is enabled', () => {
  const oldIds = ['medium-contrast-dark-v1', 'medium-contrast-dark-magic-v1', 'medium-contrast-light-v1', 'pink-splash-original'];
  assert.deepEqual(THEMES.filter(({ old }) => old).map(({ id }) => id), oldIds);
  assert.equal(THEMES.find(({ id }) => id === 'pink-splash-original').name, 'Pink Splash v1');
  assert.ok(availableThemes().every(({ old }) => !old));
  assert.equal(availableThemes(true).length, availableThemes().length + 4);
  for (const roomId of ['', 'awc', 'cyberspace-club']) {
    for (const id of oldIds) {
      assert.notEqual(resolveTheme(roomId, id).id, id);
      assert.equal(resolveTheme(roomId, id, true).id, id);
      assert.equal(resolveTheme(roomId, id, false).id, resolveTheme(roomId, null).id);
    }
  }
});
