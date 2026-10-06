import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import worker, { RoomHub } from '../../worker/src/index.js';
import { handleLibraryRequest } from '../../worker/src/library.js';
import { LIBRARY_CATALOG_PATH, libraryVersionLocation, normalizeMediaBase, assertRemoteBuildConfiguration } from '../../shared/library-contract.js';
import { ROOM_LIBRARY_PROTOCOL, trackRefOf } from '../../shared/room-library.js';
import { createLocalLibrarySnapshot } from '../scripts/lib/gizmagick-local-library.mjs';
import { seedLocalLibrary } from '../scripts/lib/gizmagick-local-seed.mjs';
import { createTrackRepository } from '../src/data/trackRepository.js';
import { validateManifest } from '../scripts/lib/track-manifests.mjs';
import { AudioEngine } from '../src/audio/audioEngine.js';
import { gizmagickManifestsPlugin } from '../scripts/gizmagick-manifests-plugin.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const snapshot = await createLocalLibrarySnapshot(publicRoot);
const migration = await readFile(new URL('../../worker/migrations/0001_gizmagick_library.sql', import.meta.url), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const oneTrack = name => ({ catalog: { tracks: { [name]: snapshot.catalog.tracks[name] } }, documents: snapshot.documents });

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  function prepare(sql, values = []) {
    return {
      bind: (...args) => prepare(sql, args),
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      run: async () => sqlite.prepare(sql).run(...values),
    };
  }
  const db = { prepare, batch: async statements => {
    sqlite.exec('BEGIN');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      sqlite.exec('COMMIT');
      return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const objects = new Map(), failed = new Set();
  const bucket = {
    put: async (key, data, options) => {
      if (failed.has(key)) throw new Error('Simulated upload failure');
      objects.set(key, { bytes: Buffer.from(data), metadata: options.httpMetadata });
    },
    get: async key => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        arrayBuffer: async () => object.bytes,
        size: object.bytes.length,
        body: new Response(object.bytes).body,
        httpEtag: `"${digest(object.bytes)}"`,
        writeHttpMetadata: headers => { headers.set('Content-Type', object.metadata.contentType); },
      };
    },
    head: key => bucket.get(key),
  };
  const env = { GIZMAGICK_DB: db, GIZMAGICK_MEDIA: bucket, GIZMAGICK_MEDIA_BASE_URL: 'https://media.gizmagick.com', GIZMAGICK_APP_ORIGINS: 'https://gizmagick.com,http://127.0.0.1:5180' };
  const request = (path, options) => handleLibraryRequest(new Request(`https://catalog.gizmagick.test${path}`, options), env);
  const seed = part => seedLocalLibrary({ db, bucket, snapshot: part || snapshot, publicRoot });
  return { sqlite, db, bucket, objects, failed, env, request, seed };
}

test('schema starts empty and API exposes only published public current versions', async t => {
  const { request, sqlite, seed } = fixture(t);
  assert.deepEqual(await (await request(LIBRARY_CATALOG_PATH)).json(), { schemaVersion: 2, tracks: {} });
  await seed();
  const catalog = await (await request(LIBRARY_CATALOG_PATH)).json();
  assert.equal(Object.keys(catalog.tracks).length, 13);
  for (const [name, entry] of Object.entries(catalog.tracks)) {
    assert.equal(entry.id, snapshot.catalog.tracks[name].id);
    assert.equal(entry.manifestUrl, `${entry.basePath}/manifest.json`);
    assert(entry.basePath.startsWith('https://media.gizmagick.com/tracks/'));
    assert(!('owner_id' in entry));
  }
  const id = catalog.tracks["Lena's Home"].id;
  for (const sql of ["visibility = 'private'", "status = 'archived'", "status = 'draft'"]) {
    sqlite.prepare(`UPDATE library_tracks SET ${sql} WHERE id = ?`).run(id);
    const hidden = await (await request(LIBRARY_CATALOG_PATH)).json();
    assert(!Object.hasOwn(hidden.tracks, "Lena's Home"));
    const entry = catalog.tracks["Lena's Home"];
    assert.equal((await request(`/api/library/tracks/${entry.id}/versions/${entry.versionId}`)).status, 404);
    assert.equal((await request(`/api/library/media/tracks/${entry.id}/versions/${entry.versionId}/manifest.json`)).status, 404);
    sqlite.prepare("UPDATE library_tracks SET visibility = 'public', status = 'published' WHERE id = ?").run(id);
  }
});

test('local seeding is repeatable, checks immutable bytes and never changes original JSON', async t => {
  const { seed, objects, request } = fixture(t);
  const original = await readFile(`${publicRoot}/trackData.json`, 'utf8');
  const part = oneTrack("Lena's Home");
  assert.equal((await seed(part)).objectsWritten, 2);
  assert.equal((await seed(part)).objectsWritten, 0);
  const entry = part.catalog.tracks["Lena's Home"];
  const location = libraryVersionLocation(undefined, entry.id, entry.versionId);
  objects.get(location.manifestKey).bytes = Buffer.from('conflicting bytes');
  await assert.rejects(seed(part), /Refusing to overwrite immutable/);
  assert.equal(Object.keys((await (await request(LIBRARY_CATALOG_PATH)).json()).tracks).length, 1);
  assert.equal(await readFile(`${publicRoot}/trackData.json`, 'utf8'), original);
});

test('failed upload leaves the old published pointer active and a retry completes a new version', async t => {
  const { seed, failed, request } = fixture(t);
  const name = "Lena's Home";
  const part = oneTrack(name);
  await seed(part);
  const original = part.catalog.tracks[name];
  const manifest = JSON.parse(snapshot.documents.get(original.manifestUrl));
  manifest.versionId = '44444444-4444-4444-8444-444444444444';
  manifest.track.title = 'New title';
  const entry = { ...original, versionId: manifest.versionId, manifestUrl: '/new-local-manifest.json' };
  const updated = { catalog: { tracks: { [name]: entry } }, documents: new Map([[entry.manifestUrl, JSON.stringify(manifest)]]) };
  const { manifestKey } = libraryVersionLocation(undefined, entry.id, entry.versionId);
  failed.add(manifestKey);
  await assert.rejects(seed(updated), /upload failure/);
  assert.equal((await (await request(LIBRARY_CATALOG_PATH)).json()).tracks[name].versionId, original.versionId);
  assert.equal((await request(`/api/library/tracks/${entry.id}/versions/${entry.versionId}`)).status, 404);
  failed.clear();
  await seed(updated);
  assert.equal((await (await request(LIBRARY_CATALOG_PATH)).json()).tracks[name].versionId, entry.versionId);
  const historical = await request(`/api/library/tracks/${entry.id}/versions/${original.versionId}`);
  assert.equal(historical.status, 200);
  assert.equal((await historical.json()).versionId, original.versionId);
});

test('failed D1 publication rolls back metadata and retries verified objects safely', async t => {
  const { seed, sqlite, objects, request } = fixture(t);
  const name = "Lena's Home";
  const original = snapshot.catalog.tracks[name];
  await seed(oneTrack(name));
  const manifest = JSON.parse(snapshot.documents.get(original.manifestUrl));
  manifest.versionId = '55555555-5555-4555-8555-555555555555';
  const entry = { ...original, versionId: manifest.versionId, manifestUrl: '/next-local-manifest.json' };
  const updated = { catalog: { tracks: { [name]: entry } }, documents: new Map([[entry.manifestUrl, JSON.stringify(manifest)]]) };
  sqlite.exec(`CREATE TRIGGER simulate_pointer_failure BEFORE UPDATE ON library_tracks
    WHEN NEW.current_version_id = '${manifest.versionId}'
    BEGIN SELECT RAISE(ABORT, 'Simulated publication failure'); END;`);
  await assert.rejects(seed(updated), /publication failure/);
  assert.equal((await (await request(LIBRARY_CATALOG_PATH)).json()).tracks[name].versionId, original.versionId);
  assert.equal(sqlite.prepare('SELECT version_id FROM library_track_versions WHERE version_id = ?').get(entry.versionId), undefined);
  assert(objects.has(libraryVersionLocation(undefined, entry.id, entry.versionId).manifestKey));
  sqlite.exec('DROP TRIGGER simulate_pointer_failure');
  assert.equal((await seed(updated)).objectsWritten, 0);
  assert.equal((await (await request(LIBRARY_CATALOG_PATH)).json()).tracks[name].versionId, entry.versionId);
});

test('schema rejects cross-track pointers, invalid metadata and updates to published versions', async t => {
  const { seed, sqlite } = fixture(t);
  await seed(oneTrack("Lena's Home"));
  const entry = snapshot.catalog.tracks["Lena's Home"];
  assert.throws(() => sqlite.prepare("UPDATE library_track_versions SET title = 'changed' WHERE track_id = ?").run(entry.id), /immutable/);
  assert.throws(() => sqlite.prepare("UPDATE library_tracks SET current_version_id = '44444444-4444-4444-8444-444444444444' WHERE id = ?").run(entry.id), /FOREIGN KEY/);
  assert.throws(() => sqlite.prepare("UPDATE library_tracks SET status = 'invalid' WHERE id = ?").run(entry.id), /CHECK/);
});

test('new tracks without compatibility names use IDs as catalog keys', async t => {
  const { seed, sqlite, request } = fixture(t);
  await seed(oneTrack("Lena's Home"));
  const entry = snapshot.catalog.tracks["Lena's Home"];
  sqlite.prepare('UPDATE library_tracks SET legacy_key = NULL WHERE id = ?').run(entry.id);
  const catalog = await (await request(LIBRARY_CATALOG_PATH)).json();
  assert.deepEqual(Object.keys(catalog.tracks), [entry.id]);
});

test('catalog handles HEAD, CORS, preflight, unsupported writes and missing routes', async t => {
  const { request } = fixture(t);
  const headers = { Origin: 'https://gizmagick.com' };
  const get = await request(LIBRARY_CATALOG_PATH, { headers });
  assert.equal(get.headers.get('Access-Control-Allow-Origin'), headers.Origin);
  assert.equal(get.headers.get('Cache-Control'), 'no-store');
  assert.equal(get.headers.get('Vary'), 'Origin');
  assert.equal(get.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(await (await request(LIBRARY_CATALOG_PATH, { method: 'HEAD', headers })).text(), '');
  assert.equal((await request(LIBRARY_CATALOG_PATH, { method: 'OPTIONS', headers })).status, 204);
  assert.equal((await request(LIBRARY_CATALOG_PATH, { headers: { Origin: 'https://evil.test' } })).status, 403);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request(LIBRARY_CATALOG_PATH, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  }
  assert.equal((await request('/api/library/missing')).status, 404);
  assert.equal((await request('/api/library/tracks/not-a-uuid/versions/not-a-uuid')).status, 404);
  assert.equal(await request('/unrelated'), null);
});

test('missing bindings, migration failures and corrupt metadata fail safely without details', async t => {
  const { env, request } = fixture(t);
  delete env.GIZMAGICK_DB;
  assert.equal((await request(LIBRARY_CATALOG_PATH)).status, 503);
  env.GIZMAGICK_DB = { prepare: () => { throw new Error('secret SQL configuration'); } };
  const failed = await request(LIBRARY_CATALOG_PATH);
  assert.equal(failed.status, 503);
  assert(!((await failed.text()).includes('secret')));
  // Restore a fixture to exercise an unsafe compatibility key from storage.
  const other = fixture(t);
  await other.seed(oneTrack("Lena's Home"));
  other.sqlite.prepare("UPDATE library_tracks SET legacy_key = '__proto__'").run();
  assert.equal((await other.request(LIBRARY_CATALOG_PATH)).status, 503);
});

test('local media reads immutable manifests/audio including escaped filenames, and blocks arbitrary objects', async t => {
  const { seed, request, env } = fixture(t);
  await seed(oneTrack("Lena's Home"));
  const entry = snapshot.catalog.tracks["Lena's Home"];
  const prefix = `/api/library/media/tracks/${entry.id}/versions/${entry.versionId}`;
  const manifest = await request(`${prefix}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('Content-Type'), 'application/json');
  assert.equal(manifest.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await manifest.json()).versionId, entry.versionId);
  const document = JSON.parse(snapshot.documents.get(entry.manifestUrl));
  const asset = Object.values(document.assets)[0];
  const encodedPath = `audio/${encodeURIComponent(asset.path.slice(6))}`;
  const audio = await request(`${prefix}/${encodedPath}`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('Content-Type'), 'audio/ogg');
  assert.equal(digest(Buffer.from(await audio.arrayBuffer())), asset.sha256);
  assert.equal(await (await request(`${prefix}/${encodedPath}`, { method: 'HEAD' })).text(), '');
  for (const suffix of ['audio/missing.ogg', 'audio/%2Fsecret.ogg', 'audio/.hidden.ogg', 'setup-check.txt', 'audio/file.txt']) assert.equal((await request(`${prefix}/${suffix}`)).status, 404);
  delete env.GIZMAGICK_MEDIA;
  assert.equal((await request(`${prefix}/manifest.json`)).status, 503);
});

test('remote repository reads the D1 catalog and R2 manifests and preserves all legacy playback metadata', async t => {
  const { seed, request } = fixture(t);
  await seed();
  const calls = [];
  const repository = createTrackRepository({ source: 'remote', validateManifest, fetchImpl: async url => {
    calls.push(url);
    if (url === LIBRARY_CATALOG_PATH) return request(url);
    const path = new URL(url).pathname;
    return request(`/api/library/media${path}`);
  } });
  const engine = new AudioEngine();
  for (const [name, legacy] of Object.entries(snapshot.catalog.tracks)) {
    const data = await repository.loadTrack(name);
    assert.equal(data.versionId, legacy.versionId);
    assert.equal(data.trackId, legacy.id);
    assert.equal(Object.keys(data.clips).length, Object.keys(JSON.parse(snapshot.documents.get(legacy.manifestUrl)).clips).length);
    const file = Object.values(data.clips)[0].file.base;
    assert.equal(engine._buildAudioUrlForBase(file, data.basePath), `${data.basePath}/audio/${encodeURIComponent(file)}`);
  }
  assert.equal(calls.length, 14);
  assert(calls.every(url => url === LIBRARY_CATALOG_PATH || url.startsWith('https://media.gizmagick.com/tracks/')));
});

test('remote repository rejects URL substitution, mismatched identity and failures without legacy fallback', async t => {
  const { seed, request } = fixture(t);
  await seed(oneTrack("Lena's Home"));
  const catalog = await (await request(LIBRARY_CATALOG_PATH)).json();
  for (const mutation of [
    entry => { entry.basePath = 'https://evil.test/tracks'; },
    entry => { entry.manifestUrl += '?other=1'; },
    entry => { entry.versionId = '44444444-4444-4444-8444-444444444444'; },
  ]) {
    const document = structuredClone(catalog);
    mutation(document.tracks["Lena's Home"]);
    const repository = createTrackRepository({ source: 'remote', validateManifest, fetchImpl: async () => Response.json(document) });
    await assert.rejects(repository.loadCatalog(), /Untrusted Gizmagick media location/);
  }
  let fail = true;
  const calls = [];
  const repository = createTrackRepository({ source: 'remote', validateManifest, fetchImpl: async url => {
    calls.push(url);
    return fail ? new Response('', { status: 503 }) : Response.json(catalog);
  } });
  await assert.rejects(repository.loadCatalog(), /503/);
  fail = false;
  assert.equal(Object.keys(await repository.loadCatalog()).length, 1);
  assert.deepEqual(calls, [LIBRARY_CATALOG_PATH, LIBRARY_CATALOG_PATH]);
});

test('pinned loads do not depend on the current catalog and reject untrusted version responses', async t => {
  const f = fixture(t);
  const name = "Lena's Home";
  await f.seed(oneTrack(name));
  const pin = trackRefOf(snapshot.catalog.tracks[name]);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    assert.notEqual(url, LIBRARY_CATALOG_PATH);
    return url.startsWith('/api/library/') ? f.request(url) : f.request(`/api/library/media${new URL(url).pathname}`);
  };
  const repository = createTrackRepository({ source: 'remote', validateManifest, fetchImpl });
  assert.equal((await repository.loadTrack(name, pin)).versionId, pin.versionId);
  assert.equal(calls.length, 2);
  for (const mutate of [
    entry => { entry.manifestUrl = 'https://evil.test/manifest.json'; },
    entry => { entry.versionId = '77777777-7777-4777-8777-777777777777'; entry.basePath = libraryVersionLocation(undefined, entry.id, entry.versionId).basePath; entry.manifestUrl = `${entry.basePath}/manifest.json`; },
  ]) {
    const entry = (await (await f.request(LIBRARY_CATALOG_PATH)).json()).tracks[name];
    mutate(entry);
    const bad = createTrackRepository({ source: 'remote', validateManifest, fetchImpl: async () => Response.json(entry) });
    await assert.rejects(bad.loadTrack(name, pin), /Untrusted|identity mismatch/);
  }
  const absolute = createTrackRepository({ source: 'remote', remoteCatalogUrl: 'https://catalog.test/api/library/catalog', validateManifest, fetchImpl: async url => {
    assert.equal(url, `https://catalog.test/api/library/tracks/${pin.trackId}/versions/${pin.versionId}`);
    return new Response('', { status: 404 });
  } });
  await assert.rejects(absolute.loadTrack(name, pin), /404/);
  await assert.rejects(repository.loadTrack(name, { ...pin, versionId: 'invalid' }), /Invalid.*reference/);
});

test('production builds cannot embed localhost defaults', () => {
  assert.throws(() => normalizeMediaBase('http://media.gizmagick.com'), /HTTPS/);
  assert.throws(() => normalizeMediaBase('https://media.gizmagick.com/?bad=1'), /query/);
  assert.throws(() => normalizeMediaBase('https://user:password@media.gizmagick.com'), /credentials/);
  assert.equal(normalizeMediaBase('http://localhost:8787/api/library/media/'), 'http://localhost:8787/api/library/media');
  assert.throws(() => assertRemoteBuildConfiguration({ source: 'remote', command: 'build' }), /require/);
  assert.throws(() => assertRemoteBuildConfiguration({ source: 'remote', command: 'build', catalogUrl: 'https://catalog.test/api/library/catalog', mediaBaseUrl: 'http://localhost:8787/api/library/media' }), /production HTTPS/);
  assert.doesNotThrow(() => assertRemoteBuildConfiguration({ source: 'remote', command: 'build', catalogUrl: 'https://catalog.test/api/library/catalog', mediaBaseUrl: 'https://media.gizmagick.com' }));
  assert.doesNotThrow(() => assertRemoteBuildConfiguration({ source: 'remote', command: 'serve' }));
});

test('two room clients load the historical pin after catalog republishing, including a queued pin', async t => {
  const f = fixture(t);
  const name = "Lena's Home";
  await f.seed(oneTrack(name));
  const original = snapshot.catalog.tracks[name];
  const pin = trackRefOf(original);
  const hub = new RoomHub({}, f.env);
  const messages = [], joinedMessages = [];
  const director = { send: value => messages.push(JSON.parse(value)) };
  const joiner = { send: value => joinedMessages.push(JSON.parse(value)) };
  const hello = { type: 'HELLO', roomId: 'pinned', trackSource: 'remote', roomProtocol: ROOM_LIBRARY_PROTOCOL };
  await hub.webSocketMessage(director, JSON.stringify({ ...hello, role: 'GM' }));
  await hub.webSocketMessage(director, JSON.stringify({ type: 'SET_TRACK_REQUEST', name, trackRef: pin }));
  await hub.webSocketMessage(director, JSON.stringify({ type: 'QUEUE_TRACK_REQUEST', name, trackRef: pin }));
  const manifest = JSON.parse(snapshot.documents.get(original.manifestUrl));
  manifest.versionId = '66666666-6666-4666-8666-666666666666';
  manifest.track.title = 'New published title';
  const entry = { ...original, versionId: manifest.versionId, manifestUrl: '/republished.json' };
  await f.seed({ catalog: { tracks: { [name]: entry } }, documents: new Map([[entry.manifestUrl, JSON.stringify(manifest)]]) });
  await hub.webSocketMessage(joiner, JSON.stringify({ ...hello, role: 'Player' }));
  const state = joinedMessages.find(value => value.type === 'STATE');
  assert.deepEqual(state.selectedTrackRef, pin);
  assert.deepEqual(state.queuedTrackRef, pin);
  const catalog = await (await f.request(LIBRARY_CATALOG_PATH)).json();
  assert.equal(catalog.tracks[name].versionId, entry.versionId);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.startsWith('/api/library/')) return f.request(url);
    return f.request(`/api/library/media${new URL(url).pathname}`);
  };
  // Simulate separate browsers whose catalogs both now point at the new version.
  for (const received of [messages.find(value => value.type === 'SET_TRACK').trackRef, state.selectedTrackRef, state.queuedTrackRef]) {
    const repository = createTrackRepository({ source: 'remote', validateManifest, fetchImpl });
    const data = await repository.loadTrack(name, received);
    assert.equal(data.versionId, original.versionId);
    assert.equal(data.entry.defaultDisplayName, name);
    assert.equal(Object.keys(data.clips).length, 1);
    assert(!calls.at(-1).includes(entry.versionId));
  }
  // Explicitly promoting the historical queued version must not follow current.
  await hub.webSocketMessage(director, JSON.stringify({ type: 'SET_TRACK_REQUEST', name, trackRef: state.queuedTrackRef }));
  assert.deepEqual(hub.roomState.get('pinned').selectedTrackRef, pin);
  f.sqlite.prepare("UPDATE library_tracks SET visibility = 'private' WHERE id = ?").run(original.id);
  await hub.webSocketMessage(director, JSON.stringify({ type: 'SET_TRACK_REQUEST', name, trackRef: pin }));
  assert.equal(messages.at(-1).code, 'TRACK_UNAVAILABLE');
  const repository = createTrackRepository({ source: 'remote', validateManifest, fetchImpl: async url => url === LIBRARY_CATALOG_PATH ? Response.json(catalog) : f.request(url) });
  await assert.rejects(repository.loadTrack(name, pin), /404/);
});

test('remote Vite source ships validation but emits no local catalog or manifests', async () => {
  const plugin = gizmagickManifestsPlugin({ source: 'remote', publicRoot });
  assert(plugin.load(plugin.resolveId('virtual:gizmagick-manifest-validator')).includes('export default'));
  plugin.configResolved({ command: 'build' });
  await plugin.buildStart.call({ emitFile: () => assert.fail('Remote builds must not generate a local catalog') });
  await plugin.configureServer({ middlewares: { use: () => assert.fail('Remote dev must use the Worker API') } });
});

test('local-only seed CLI refuses remote flags before accessing storage', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/gizmagick-library-local.mjs', import.meta.url)), '--remote'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert(result.stderr.includes('local-only and accepts no remote flags'));
  assert(!result.stdout.includes('Seeding'));
});

test('Worker retains health and WebSocket routing separately from the catalog API', async () => {
  const health = await worker.fetch(new Request('https://worker.test/health'), {}, {});
  assert.deepEqual(await health.json(), { ok: true, worker: 'gizmagick-worker' });
  assert.equal((await worker.fetch(new Request('https://worker.test/ws'), {}, {})).status, 426);
  assert.equal((await worker.fetch(new Request('https://worker.test/not-found'), {}, {})).status, 404);
});
