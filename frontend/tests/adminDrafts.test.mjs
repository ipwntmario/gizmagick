import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAdminHandler } from '../../worker/src/admin.js';
import { DRAFT_LIMITS, checkOggIntake, readBoundedBody } from '../../worker/src/admin-drafts.js';
import { handleLibraryRequest } from '../../worker/src/library.js';
import { createManifestValidatorSource } from '../scripts/lib/gizmagick-local-library.mjs';
import { convertLegacyTrack } from '../scripts/lib/track-manifests.mjs';

const owner = { id: 'access:' + 'a'.repeat(64), email: 'admin@example.com', role: 'admin' };
const other = { ...owner, id: 'access:' + 'b'.repeat(64) };
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migrations = await Promise.all(['0001_gizmagick_library.sql', '0002_gizmagick_drafts.sql'].map(name => read(`../../worker/migrations/${name}`)));
const catalog = JSON.parse(await read('../public/trackData.json')).tracks;
const trackName = "Lena's Home";
const entry = catalog[trackName];
const clips = JSON.parse(await read(`../public${entry.basePath}/clipData.json`));
const sections = JSON.parse(await read(`../public${entry.basePath}/sectionData.json`));
const manifest = convertLegacyTrack(trackName, entry, clips, sections);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = () => ({ requestId: crypto.randomUUID(), manifest: structuredClone(manifest) });
function ogg(marker = 1) {
  const bytes = new Uint8Array(47);
  bytes.set(new TextEncoder().encode('OggS')); bytes[5] = 2; bytes[26] = 1; bytes[27] = 19;
  bytes.set(new TextEncoder().encode('OpusHead'), 28); bytes[36] = marker;
  return bytes; // Identification fixture, not decodable audio.
}
function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON;');
  for (const migration of migrations) sql.exec(migration);
  t.after(() => sql.close());
  function prepare(query, args = []) {
    return { bind: (...values) => prepare(query, values),
      first: async () => sql.prepare(query).get(...args) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...args) }),
      run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
    };
  }
  const objects = new Map();
  let failWrites = false;
  const bucket = {
    head: async key => objects.has(key) ? { size: objects.get(key).bytes.length, customMetadata: objects.get(key).customMetadata } : null,
    get: async key => objects.has(key) ? { ...(await bucket.head(key)), body: new Response(objects.get(key).bytes).body } : null,
    put: async (key, bytes, options) => {
      if (failWrites) throw new Error('private storage error containing credentials');
      assert.equal(options.onlyIf.etagDoesNotMatch, '*');
      assert.equal(options.sha256, hash(bytes));
      if (objects.has(key)) return null;
      objects.set(key, { bytes: new Uint8Array(bytes), ...options });
      return bucket.head(key);
    },
  };
  const env = { GIZMAGICK_DB: { prepare }, GIZMAGICK_DRAFTS: bucket,
    GIZMAGICK_MEDIA: { put: () => { throw new Error('Public bucket must never receive drafts'); } },
    GIZMAGICK_DRAFT_UPLOADS_ENABLED: 'true' };
  const handle = principal => createAdminHandler(async () => principal);
  const request = (path = '/api/admin/drafts', { method = 'GET', body, principal = owner, headers = {} } = {}) => handle(principal)(new Request(`https://admin.example.com${path}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': typeof body === 'object' && !(body instanceof Uint8Array) ? 'application/json' : 'application/octet-stream' } : {}), ...headers },
    ...(body !== undefined ? { body: body instanceof Uint8Array ? body : typeof body === 'object' ? JSON.stringify(body) : body } : {}),
  }), env);
  const create = (input = canonical(), principal = owner) => request('/api/admin/drafts', { method: 'POST', body: input, principal });
  const upload = (draft, bytes = ogg(), id = Object.keys(draft.manifest.assets)[0], principal = owner) => request(`/api/admin/drafts/${draft.id}/assets/${encodeURIComponent(id)}`, { method: 'PUT', body: bytes, principal });
  return { sql, objects, env, request, create, upload, failWrites: value => { failWrites = value; } };
}

test('the Worker structural validator is generated from the current canonical schema', async () => {
  assert.equal(await read('../../worker/src/generated/manifest-validator.js'), '// Generated from shared/track-manifest.schema.json; freshness is checked by tests.\n' + createManifestValidatorSource() + '\n');
});

test('canonical draft creation assigns private identities and stable request retries without public rows', async t => {
  const f = fixture(t), input = canonical();
  const response = await f.create(input);
  assert.equal(response.status, 201);
  const draft = await response.json();
  assert.notEqual(draft.manifest.track.id, manifest.track.id);
  assert.notEqual(draft.manifest.versionId, manifest.versionId);
  assert.equal(draft.publishing, false); assert.equal(draft.audioProbed, false);
  assert.equal(f.sql.prepare('SELECT owner_id FROM admin_drafts').get().owner_id, owner.id);
  assert.equal((await f.create(input)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts').get().n, 1);
  assert.equal((await f.create({ ...input, manifest: { ...input.manifest, track: { ...input.manifest.track, title: 'Changed' } } })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
});

test('legacy JSON pair import preserves the existing playback graph', async t => {
  const f = fixture(t);
  const response = await f.create({ requestId: crypto.randomUUID(), format: 'legacy', title: trackName,
    firstSection: entry.firstSection, simple: entry.simple, clipData: clips, sectionData: sections });
  assert.equal(response.status, 201);
  const draft = await response.json();
  assert.deepEqual(draft.manifest.sections, manifest.sections);
  assert.deepEqual(Object.values(draft.manifest.assets).map(a => a.path), Object.values(manifest.assets).map(a => a.path));
});

test('all legacy tracks, including Testing Time, import through the shared Worker adapter', async t => {
  const f = fixture(t);
  for (const [name, track] of Object.entries(catalog)) {
    const response = await f.create({ requestId: crypto.randomUUID(), format: 'legacy', title: name,
      firstSection: track.firstSection, simple: track.simple, test: track.test ?? false,
      clipData: JSON.parse(await read(`../public${track.basePath}/clipData.json`)),
      sectionData: JSON.parse(await read(`../public${track.basePath}/sectionData.json`)) });
    assert.equal(response.status, 201, name + ': ' + (response.status !== 201 ? await response.text() : ''));
  }
});

test('ownership is enforced for listing, reading, uploading, downloading and archiving', async t => {
  const f = fixture(t), draft = await (await f.create()).json(), asset = Object.keys(draft.manifest.assets)[0];
  await f.upload(draft);
  const list = await (await f.request('/api/admin/drafts', { principal: other })).json();
  assert.deepEqual(list.drafts, []);
  for (const suffix of ['', '/manifest', `/assets/${asset}`, '/archive']) {
    const response = await f.request(`/api/admin/drafts/${draft.id}${suffix}`, { principal: other, method: suffix === '/archive' ? 'POST' : 'GET' });
    assert.equal(response.status, 404);
  }
  assert.equal((await f.upload(draft, ogg(), asset, other)).status, 404);
});

test('upload is private, fingerprinted, retryable and cannot overwrite different bytes', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  const response = await f.upload(draft);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).audioProbed, false);
  assert.equal(f.objects.size, 1);
  assert.equal((await f.upload(draft)).status, 200);
  assert.equal(f.objects.size, 1);
  assert.equal((await f.upload(draft, ogg(2))).status, 409);
  const state = await (await f.request(`/api/admin/drafts/${draft.id}`)).json();
  assert.equal(state.missingAssets.length, 0);
  assert.equal(state.publishing, false);
  const download = await f.request(`/api/admin/drafts/${draft.id}/assets/${Object.keys(draft.manifest.assets)[0]}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Type'), 'application/octet-stream');
  assert(download.headers.get('Content-Disposition').startsWith('attachment;'));
  assert.equal(download.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), ogg());
});

test('a failed upload retains its allocation and retries without recharging quota', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  f.failWrites(true);
  const failed = await f.upload(draft);
  assert.equal(failed.status, 503);
  assert(!(await failed.text()).includes('credentials'));
  assert.equal(f.sql.prepare('SELECT state FROM admin_draft_assets').get().state, 'pending');
  f.failWrites(false);
  assert.equal((await f.upload(draft)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_assets').get().n, 1);
});

test('concurrent same-file retries converge on one allocation and one immutable object', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  const results = await Promise.all([f.upload(draft), f.upload(draft)]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(f.objects.size, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_assets').get().n, 1);
});

test('manifest fingerprints are checked rather than copied from the client', async t => {
  const f = fixture(t), input = canonical();
  Object.assign(Object.values(input.manifest.assets)[0], { byteLength: 47, sha256: '0'.repeat(64), durationSeconds: 100000 });
  const draft = await (await f.create(input)).json();
  assert.equal((await f.upload(draft)).status, 422);
  assert.equal(f.objects.size, 0);
});

test('archiving retains data, blocks writes and leaves the public catalog untouched', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  await f.upload(draft);
  const response = await f.request(`/api/admin/drafts/${draft.id}/archive`, { method: 'POST' });
  assert.deepEqual(await response.json(), { id: draft.id, status: 'archived', filesDeleted: false });
  assert.equal((await f.upload(draft)).status, 409);
  assert.equal(f.objects.size, 1);
  const catalogResponse = await handleLibraryRequest(new Request('https://admin.example.com/api/library/catalog'), f.env);
  assert.deepEqual(await catalogResponse.json(), { schemaVersion: 2, tracks: {} });
  const key = [...f.objects.keys()][0];
  const publicRead = await handleLibraryRequest(new Request(`https://admin.example.com/api/library/media/${key}`), f.env);
  assert.equal(publicRead.status, 404);
});

for (const [name, mutate] of [
  ['client ownership', input => { input.ownerId = other.id; }],
  ['unknown manifest fields', input => { input.manifest.status = 'published'; }],
  ['unsafe audio path', input => { Object.values(input.manifest.assets)[0].path = 'audio/../../private.ogg'; }],
  ['bad graph reference', input => { input.manifest.track.firstSection = 'does-not-exist'; }],
  ['prototype key', input => { input.manifest.assets = JSON.parse('{"__proto__":{"path":"audio/x.ogg"}}'); }],
  ['oversized graph', input => { input.manifest.sections = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), {}])); }],
]) test(`rejects ${name} before writing data`, async t => {
  const f = fixture(t), input = canonical(); mutate(input);
  const response = await f.create(input);
  assert([400, 422].includes(response.status));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts').get().n, 0);
  assert.equal(f.objects.size, 0);
});

test('disabled/missing/private-bucket-alias configurations fail closed', async t => {
  const f = fixture(t);
  for (const mutate of [() => { f.env.GIZMAGICK_DRAFT_UPLOADS_ENABLED = 'false'; },
    () => { f.env.GIZMAGICK_DRAFT_UPLOADS_ENABLED = 'true'; delete f.env.GIZMAGICK_DRAFTS; },
    () => { f.env.GIZMAGICK_DRAFTS = f.env.GIZMAGICK_MEDIA; }]) {
    mutate(); assert.equal((await f.create()).status, 503);
    assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.uploads, false);
  }
});

test('invalid IDs, unknown assets, bad JSON, empty bodies and unsupported MIME types are rejected', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  assert.equal((await f.request('/api/admin/drafts/not-a-uuid')).status, 404);
  assert.equal((await f.upload(draft, ogg(), 'unknown')).status, 404);
  assert.equal((await f.request('/api/admin/drafts', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request('/api/admin/drafts', { method: 'POST', body: '', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request('/api/admin/drafts', { method: 'POST', body: '<svg/>' })).status, 415);
  assert.equal((await f.upload(draft, new Uint8Array(47))).status, 422);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/assets/${Object.keys(draft.manifest.assets)[0]}`, { method: 'PUT', body: ogg(), headers: { 'Content-Type': 'text/html' } })).status, 415);
});

test('body limits count streamed bytes and do not trust Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(new Request('https://admin.example.com', { method: 'POST', body: stream, duplex: 'half' }), 8), error => error.status === 413);
  assert(cancelled);
  await assert.rejects(readBoundedBody(new Request('https://admin.example.com', { method: 'POST', body: 'abc', headers: { 'Content-Length': '1' } }), 8), error => error.status === 400);
  await assert.rejects(readBoundedBody(new Request('https://admin.example.com', { method: 'POST', body: 'abc', headers: { 'Content-Length': '9' } }), 8), error => error.status === 413);
});

test('active draft quota is enforced atomically and archive frees a draft slot, not storage bytes', async t => {
  const f = fixture(t), ids = [];
  for (let i = 0; i < DRAFT_LIMITS.activeDrafts; i++) ids.push((await (await f.create()).json()).id);
  assert.equal((await f.create()).status, 409);
  await f.request(`/api/admin/drafts/${ids[0]}/archive`, { method: 'POST' });
  assert.equal((await f.create()).status, 201);
});

test('storage quota includes pending and archived allocations and refuses excess before R2', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  for (let i = 0; i < DRAFT_LIMITS.draftBytes / DRAFT_LIMITS.audioBytes; i++) f.sql.prepare('INSERT INTO admin_draft_assets (draft_id, asset_id, object_key, byte_length, sha256) VALUES (?, ?, ?, ?, ?)')
    .run(draft.id, `reserved-${i}`, `drafts/${draft.id}/assets/reserved-${i}`, DRAFT_LIMITS.audioBytes, '0'.repeat(64));
  assert.equal((await f.upload(draft)).status, 409);
  assert.equal(f.objects.size, 0);
});

test('owner storage quota counts pending allocations across archived and active drafts', async t => {
  const f = fixture(t);
  for (let n = 0; n < 2; n++) {
    const draft = await (await f.create()).json();
    for (let i = 0; i < 16; i++) f.sql.prepare('INSERT INTO admin_draft_assets (draft_id, asset_id, object_key, byte_length, sha256) VALUES (?, ?, ?, ?, ?)')
      .run(draft.id, `reserved-${i}`, `drafts/${draft.id}/assets/reserved-${i}`, DRAFT_LIMITS.audioBytes, '0'.repeat(64));
    await f.request(`/api/admin/drafts/${draft.id}/archive`, { method: 'POST' });
  }
  const next = await (await f.create()).json();
  assert.equal((await f.upload(next)).status, 409);
  assert.equal(f.objects.size, 0);
});

test('reserved asset names cannot accidentally select archive or manifest operations', async t => {
  const f = fixture(t), input = canonical(), asset = Object.keys(input.manifest.assets)[0];
  input.manifest.assets.archive = input.manifest.assets[asset]; delete input.manifest.assets[asset];
  for (const clip of Object.values(input.manifest.clips)) for (const mode of Object.keys(clip.assetsByMode)) clip.assetsByMode[mode] = 'archive';
  const draft = await (await f.create(input)).json();
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/assets/archive`, { method: 'POST' })).status, 405);
  assert.equal((await (await f.request(`/api/admin/drafts/${draft.id}`)).json()).status, 'draft');
});

test('page exposes a functional private intake form with nonce scripts and no publication controls', async t => {
  const f = fixture(t), response = await f.request('/admin'), page = await response.text();
  assert(page.includes('Create private draft'));
  assert(page.includes('Upload selected audio privately'));
  assert(page.includes('sectionData.json'));
  assert(!page.includes('localStorage'));
  assert(!page.includes('innerHTML'));
  assert(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publishing, false);
  checkOggIntake(ogg());
});
