import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateJsonOnce } from '../../worker/src/admin-json-cache.js';

test('JSON calculation reuse requires exact document text and every context value', async () => {
  const scope = crypto.randomUUID(); let calculations = 0;
  const read = (context, text) => calculateJsonOnce([scope, context, text], async () => ({ serial: ++calculations, document: JSON.parse(text) }));
  const initial = await read('review-1', '{"valid":true}');
  assert.equal((await read('review-1', '{"valid":true}')).serial, initial.serial);
  assert.notEqual((await read('review-2', '{"valid":true}')).serial, initial.serial);
  assert.notEqual((await read('review-1', '{"valid":false}')).serial, initial.serial);
  assert.notEqual((await read('review-1', '{ "valid":true}')).serial, initial.serial);
  assert.equal(calculations, 4);
});

test('cached JSON is immutable and failed calculations never become authority', async () => {
  const scope = crypto.randomUUID();
  await assert.rejects(calculateJsonOnce([scope], async () => { throw new Error('Invalid review'); }), /Invalid review/);
  const value = await calculateJsonOnce([scope], async () => ({ sources: [{ sha256: 'original' }] }));
  assert.throws(() => { value.sources[0].sha256 = 'changed'; }, TypeError);
  assert.throws(() => value.sources.push({}), TypeError);
  assert.equal((await calculateJsonOnce([scope], () => assert.fail('Matching calculation should be reused'))).sources[0].sha256, 'original');
});

test('cache eviction and oversized inputs safely recalculate instead of trusting an incomplete key', async () => {
  const scope = crypto.randomUUID(); let calculations = 0;
  const read = key => calculateJsonOnce([scope, key], () => ({ serial: ++calculations }));
  const first = await read('first');
  for (let i = 0; i < 12; i++) await read(String(i));
  assert.notEqual((await read('first')).serial, first.serial);
  const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
  assert.notEqual((await read(oversized)).serial, (await read(oversized)).serial);
});

test('mutable or non-text cache keys cannot impersonate a checked document', async () => {
  await assert.rejects(calculateJsonOnce([{ text: 'review' }], () => assert.fail('Non-text input must be rejected')), TypeError);
  const parts = [crypto.randomUUID(), 'original'];
  await calculateJsonOnce(parts, () => ({ trusted: true }));
  parts[1] = 'changed';
  assert.equal((await calculateJsonOnce(parts, () => ({ trusted: false }))).trusted, false);
});
