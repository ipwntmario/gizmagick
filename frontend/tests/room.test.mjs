import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../worker/src/index.js', import.meta.url));
const { RoomHub } = await import(`data:text/javascript;base64,${source.toString('base64')}`);

function fixture(role = 'GM', ready = true) {
  const hub = new RoomHub({}, {});
  const messages = [];
  const socket = { send: message => messages.push(JSON.parse(message)) };
  hub.clients.set(socket, { id: 'one', roomId: 'test', role, ready, name: 'Test' });
  const send = data => hub.webSocketMessage(socket, JSON.stringify(data));
  return { hub, socket, messages, send };
}

test('accepted Play broadcasts only Play, never Pause', () => {
  const { send, messages } = fixture();
  send({ type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main', serverMs: 12345 });
  assert.deepEqual(messages.map(message => message.type), ['PLAY']);
});

test('Play respects role and readiness gates', () => {
  for (const [role, ready, code] of [['PASSIVE', true, 'FORBIDDEN'], ['GM', false, 'NOT_READY']]) {
    const { send, messages } = fixture(role, ready);
    send({ type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].code, code);
  }
});

test('presence distinguishes idle, loading, and ready users', () => {
  const hub = new RoomHub({}, {});
  const messages = [];
  const socket = { send: message => messages.push(JSON.parse(message)) };
  const send = data => hub.webSocketMessage(socket, JSON.stringify(data));
  const presence = () => messages.filter(message => message.type === 'PRESENCE').at(-1).users[0];

  send({ type: 'HELLO', roomId: 'test', name: 'Listener' });
  assert.deepEqual({ ready: presence().ready, loading: presence().loading }, { ready: false, loading: false });

  send({ type: 'SET_READY', ready: false, loading: true });
  assert.deepEqual({ ready: presence().ready, loading: presence().loading }, { ready: false, loading: true });

  send({ type: 'SET_READY', ready: true });
  assert.deepEqual({ ready: presence().ready, loading: presence().loading }, { ready: true, loading: false });

  send({ type: 'SET_READY', ready: false });
  assert.deepEqual({ ready: presence().ready, loading: presence().loading }, { ready: false, loading: false });
});

test('commands remain isolated to their room', () => {
  const { hub, send } = fixture();
  const otherMessages = [];
  hub.clients.set({ send: value => otherMessages.push(value) }, { id: 'other', roomId: 'other', role: 'PASSIVE', ready: true });
  send({ type: 'PLAY_REQUEST', trackName: 'Track', sectionName: 'Main' });
  assert.deepEqual(otherMessages, []);
});

test('queued tracks are broadcast, stored, and cleared for the room', () => {
  const { hub, send, messages } = fixture();
  send({ type: 'QUEUE_TRACK_REQUEST', name: 'Next Track' });
  assert.deepEqual(messages.at(-1), { type: 'QUEUE_TRACK', name: 'Next Track' });
  assert.equal(hub.roomState.get('test').queuedTrack, 'Next Track');

  send({ type: 'CLEAR_TRACK_QUEUE_REQUEST' });
  assert.deepEqual(messages.at(-1), { type: 'CLEAR_TRACK_QUEUE' });
  assert.equal(hub.roomState.get('test').queuedTrack, null);
});

test('explicit queued Play and Load choices survive room broadcasts', () => {
  const { hub, send, messages } = fixture();
  send({ type: 'QUEUE_TRACK_REQUEST', name: 'Next Track', playAfterRelease: true });
  assert.deepEqual(messages.at(-1), { type: 'QUEUE_TRACK', name: 'Next Track', playAfterRelease: true });
  assert.equal(hub.roomState.get('test').queuedTrackPlayAfterRelease, true);

  send({ type: 'QUEUE_TRACK_REQUEST', name: 'Next Track', playAfterRelease: false });
  assert.deepEqual(messages.at(-1), { type: 'QUEUE_TRACK', name: 'Next Track', playAfterRelease: false });
  assert.equal(hub.roomState.get('test').queuedTrackPlayAfterRelease, false);

  send({ type: 'CLEAR_TRACK_QUEUE_REQUEST' });
  assert.equal(hub.roomState.get('test').queuedTrackPlayAfterRelease, null);
});

test('a joiner receives a queued track even before the first track is loaded', () => {
  const { hub, send } = fixture();
  send({ type: 'QUEUE_TRACK_REQUEST', name: 'First Track', playAfterRelease: false });

  const messages = [];
  const joiner = { send: message => messages.push(JSON.parse(message)) };
  hub.webSocketMessage(joiner, JSON.stringify({ type: 'HELLO', roomId: 'test', role: 'Player', name: 'Joiner' }));

  assert.deepEqual(messages.find(message => message.type === 'STATE'), {
    type: 'STATE',
    seed: null,
    queuedSection: null,
    queuedMode: null,
    queuedTrack: 'First Track',
    queuedTrackPlayAfterRelease: false,
    trackVolume: null,
    autoplay: true,
    playing: null,
  });
});

test('cancelling a stop restores the room playing snapshot', () => {
  const { hub, send, messages } = fixture();
  const playing = { trackName: 'Track', sectionName: 'Main', serverMs: 12345 };
  hub.roomState.set('test', { playing });

  send({ type: 'STOP_REQUEST', fade: true });
  assert.equal(hub.roomState.get('test').playing, null);
  send({ type: 'CANCEL_STOP_REQUEST' });

  assert.deepEqual(messages.at(-1), { type: 'CANCEL_STOP' });
  assert.deepEqual(hub.roomState.get('test').playing, playing);
});

test('seek is synchronized within the room and restricted to the active user', () => {
  const { send, messages } = fixture();
  send({ type: 'SEEK_REQUEST', positionSeconds: 42.5, serverMs: 13000 });
  assert.deepEqual(messages.at(-1), { type: 'SEEK', positionSeconds: 42.5, serverMs: 13000 });

  const passive = fixture('PASSIVE');
  passive.send({ type: 'SEEK_REQUEST', positionSeconds: 10, serverMs: 13000 });
  assert.equal(passive.messages.at(-1).code, 'FORBIDDEN');
});
