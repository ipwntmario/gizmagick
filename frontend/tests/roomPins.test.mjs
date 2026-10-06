import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomHub } from '../../worker/src/index.js';
import { ROOM_LIBRARY_PROTOCOL, sameTrackRef, trackAssetKey, validTrackRef } from '../../shared/room-library.js';

const trackId = '11111111-1111-4111-8111-111111111111';
const oldPin = { trackId, versionId: '22222222-2222-4222-8222-222222222222' };
const newPin = { trackId, versionId: '33333333-3333-4333-8333-333333333333' };
const hello = { type: 'HELLO', roomId: 'pins', trackSource: 'remote', roomProtocol: ROOM_LIBRARY_PROTOCOL };
function socket() {
  const messages = [];
  let attachment;
  return { messages, send: value => messages.push(JSON.parse(value)),
    serializeAttachment: value => { attachment = structuredClone(value); },
    deserializeAttachment: () => structuredClone(attachment) };
}
function fixture({ storage = null, first = async (id, versionId) => id === trackId && [oldPin.versionId, newPin.versionId].includes(versionId) ? { id, legacy_key: 'Track' } : null } = {}) {
  const db = { prepare: () => ({ bind: (id, versionId) => ({ first: () => first(id, versionId) }) }) };
  const hub = new RoomHub({ storage }, { GIZMAGICK_DB: db });
  const director = socket(), listener = socket();
  const send = (ws, data) => hub.webSocketMessage(ws, JSON.stringify(data));
  const join = async () => {
    await send(director, { ...hello, name: 'Director', role: 'GM', ready: true });
    await send(listener, { ...hello, name: 'Listener', role: 'PASSIVE', ready: true });
  };
  const select = pin => send(director, { type: 'SET_TRACK_REQUEST', name: 'Untrusted display alias', trackRef: pin });
  const context = () => ({ trackRef: hub.roomState.get('pins').selectedTrackRef, selectionId: hub.roomState.get('pins').seed });
  const ready = ws => send(ws, { type: 'SET_READY', ready: true, ...context() });
  return { hub, director, listener, send, join, select, context, ready };
}

test('room handshake isolates remote and legacy clients without changing legacy rooms', async () => {
  const f = fixture();
  await f.join();
  assert.equal(f.director.messages[0].roomProtocol, ROOM_LIBRARY_PROTOCOL);
  assert.equal(f.hub.clients.get(f.director).ready, false);
  const legacy = socket();
  await f.send(legacy, { type: 'HELLO', roomId: 'pins' });
  assert.equal(legacy.messages.at(-1).code, 'ROOM_SOURCE_MISMATCH');
  assert(!f.hub.clients.has(legacy));
  const oldProtocol = socket();
  await f.send(oldProtocol, { ...hello, roomProtocol: 'unsupported' });
  assert.equal(oldProtocol.messages.at(-1).code, 'ROOM_SOURCE_MISMATCH');
  await f.send(legacy, { type: 'HELLO', roomId: 'legacy-room' });
  const incompatible = socket();
  await f.send(incompatible, { ...hello, roomId: 'legacy-room' });
  assert.equal(incompatible.messages.at(-1).code, 'ROOM_SOURCE_MISMATCH');
});

test('readiness and transport commands are tied to the exact selected pin and selection', async () => {
  const f = fixture();
  await f.join();
  await f.select(oldPin);
  assert.equal(f.director.messages.at(-1).name, 'Track');
  const oldContext = f.context();
  await f.ready(f.director);
  await f.send(f.listener, { type: 'SET_READY', ready: true, ...oldContext, trackRef: newPin });
  assert.equal(f.hub.clients.get(f.listener).ready, false);
  await f.send(f.director, { type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main', ...oldContext });
  assert.equal(f.director.messages.at(-1).code, 'NOT_READY');
  await f.ready(f.listener);
  await f.send(f.director, { type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main', ...oldContext });
  assert.deepEqual(f.director.messages.at(-1).trackRef, oldPin);
  assert.equal(f.director.messages.at(-1).type, 'PLAY');
  await f.select(newPin);
  assert.equal(f.hub.clients.get(f.director).ready, false);
  assert.equal(f.hub.clients.get(f.listener).ready, false);
  assert.equal(f.hub.roomState.get('pins').playing, null);
  for (const type of ['PLAY_REQUEST', 'PAUSE_REQUEST', 'RESUME_REQUEST', 'STOP_REQUEST', 'SEEK_REQUEST', 'QUEUE_SECTION_REQUEST', 'QUEUE_MODE_REQUEST']) {
    await f.send(f.director, { type, trackName: 'Track', sectionName: 'Main', ...oldContext, override: true });
    assert.equal(f.director.messages.at(-1).code, 'STALE_TRACK');
  }
  await f.send(f.listener, { type: 'SET_READY', ready: true, ...oldContext });
  assert.equal(f.hub.clients.get(f.listener).ready, false);
  await f.send(f.listener, { type: 'SET_READY', ready: true, ...f.context(), selectionId: oldContext.selectionId });
  assert.equal(f.hub.clients.get(f.listener).ready, false);
});

test('queued pins, late joins and precise sync preserve historical identity', async () => {
  const f = fixture();
  await f.join();
  await f.select(oldPin);
  await f.send(f.director, { type: 'QUEUE_TRACK_REQUEST', trackRef: newPin, playAfterRelease: false });
  assert.deepEqual(f.listener.messages.at(-1).trackRef, newPin);
  await f.ready(f.director);
  await f.ready(f.listener);
  await f.send(f.director, { type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main', ...f.context() });
  const late = socket();
  await f.send(late, { ...hello });
  const state = late.messages.find(value => value.type === 'STATE');
  assert.deepEqual(state.selectedTrackRef, oldPin);
  assert.deepEqual(state.queuedTrackRef, newPin);
  assert.equal(state.queuedTrackPlayAfterRelease, false);
  assert.deepEqual(state.playing.trackRef, oldPin);
  const to = f.hub.clients.get(late).id;
  const precise = { trackName: 'Track', sectionName: 'Main', clipName: 'A', rngDrawCount: 2, ...f.context() };
  await f.send(f.director, { type: 'SYNC_RESPONSE', to, state: { ...precise, trackRef: newPin } });
  assert.equal(f.director.messages.at(-1).code, 'STALE_TRACK');
  await f.send(f.director, { type: 'SYNC_RESPONSE', to, state: precise });
  assert.deepEqual(late.messages.at(-1), { type: 'SYNC_STATE', state: precise });
  await f.send(f.director, { type: 'CLEAR_TRACK_QUEUE_REQUEST' });
  assert.equal(f.hub.roomState.get('pins').queuedTrackRef, null);
});

test('invalid versions and unauthorized selection never change room state', async () => {
  const f = fixture();
  await f.join();
  await f.select(oldPin);
  for (const pin of [null, { trackId, versionId: 'invalid' }, { ...oldPin, versionId: '44444444-4444-4444-8444-444444444444' }]) {
    await f.select(pin);
    assert(['INVALID_TRACK_REF', 'TRACK_UNAVAILABLE'].includes(f.director.messages.at(-1).code));
    assert.deepEqual(f.hub.roomState.get('pins').selectedTrackRef, oldPin);
  }
  await f.send(f.listener, { type: 'SET_TRACK_REQUEST', trackRef: newPin });
  assert.equal(f.listener.messages.at(-1).code, 'FORBIDDEN');
  assert.deepEqual(f.hub.roomState.get('pins').selectedTrackRef, oldPin);
  f.hub.env.GIZMAGICK_DB.prepare = () => { throw new Error('secret database detail'); };
  await f.select(newPin);
  assert.equal(f.director.messages.at(-1).code, 'LIBRARY_UNAVAILABLE');
  assert(!JSON.stringify(f.director.messages.at(-1)).includes('secret'));
});

test('database validation is serialized with newer selections and queue clears', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ first: async (id, versionId) => {
    if (versionId === oldPin.versionId) await wait;
    return { id, legacy_key: 'Track' };
  } });
  await f.join();
  const older = f.select(oldPin), newer = f.select(newPin);
  release();
  await Promise.all([older, newer]);
  assert.deepEqual(f.hub.roomState.get('pins').selectedTrackRef, newPin);
  await Promise.all([
    f.send(f.director, { type: 'QUEUE_TRACK_REQUEST', trackRef: oldPin }),
    f.send(f.director, { type: 'CLEAR_TRACK_QUEUE_REQUEST' }),
  ]);
  assert.equal(f.hub.roomState.get('pins').queuedTrackRef, null);
});

test('pins and readiness attachments survive a Durable Object hibernation instance', async () => {
  const records = new Map();
  const storage = { get: async key => structuredClone(records.get(key)), put: async (key, value) => records.set(key, structuredClone(value)) };
  const f = fixture({ storage });
  await f.join();
  await f.select(oldPin);
  await f.ready(f.director);
  await f.ready(f.listener);
  await f.send(f.director, { type: 'QUEUE_TRACK_REQUEST', trackRef: newPin });
  let restored;
  const resumed = new RoomHub({ storage, getWebSockets: () => [f.director, f.listener], blockConcurrencyWhile: callback => { restored = callback(); } }, f.hub.env);
  await restored;
  assert.deepEqual(resumed.roomState.get('pins').selectedTrackRef, oldPin);
  assert.deepEqual(resumed.roomState.get('pins').queuedTrackRef, newPin);
  assert.deepEqual(resumed.clients.get(f.listener).readyTrackRef, oldPin);
  await resumed.webSocketMessage(f.director, JSON.stringify({ type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main', ...f.context() }));
  assert.equal(f.director.messages.at(-1).type, 'PLAY');
});

test('same-name versions have distinct asset cache keys; malformed references cannot masquerade as pins', () => {
  assert.notEqual(trackAssetKey('Track', oldPin), trackAssetKey('Track', newPin));
  assert(sameTrackRef(oldPin, structuredClone(oldPin)));
  assert(!sameTrackRef(oldPin, newPin));
  assert(!validTrackRef({ trackId: 1, versionId: 2 }));
});
