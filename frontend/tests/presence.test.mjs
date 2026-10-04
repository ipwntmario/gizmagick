import test from 'node:test';
import assert from 'node:assert/strict';
import { getPresenceChanges } from '../src/data/presence.js';

test('presence changes include every join and leave in roster order', () => {
  const previous = new Map([['a', 'Ada'], ['b', 'Bryn']]);
  const next = new Map([['b', 'Bryn'], ['c', 'Cleo'], ['d', 'Dara']]);
  assert.deepEqual(getPresenceChanges(previous, next), [
    { kind: 'join', name: 'Cleo' },
    { kind: 'join', name: 'Dara' },
    { kind: 'leave', name: 'Ada' },
  ]);
});

test('changing a name without changing user ID does not create a notice', () => {
  assert.deepEqual(
    getPresenceChanges(new Map([['a', 'Ada']]), new Map([['a', 'Ada Lovelace']])),
    [],
  );
});
