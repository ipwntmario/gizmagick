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
import { probeManifest, createProbeReport } from '../scripts/lib/audio-probe.mjs';
import { REVIEW_POLICY, createReviewReport } from '../../shared/draft-review.js';
import { fileURLToPath } from 'node:url';

const owner = { id: 'access:' + 'a'.repeat(64), email: 'admin@example.com', role: 'admin' };
const other = { ...owner, id: 'access:' + 'b'.repeat(64) };
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migrations = await Promise.all(['0001_gizmagick_library.sql', '0002_gizmagick_drafts.sql', '0003_gizmagick_draft_reviews.sql', '0004_gizmagick_publications.sql'].map(name => read(`../../worker/migrations/${name}`)));
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
    head: async key => objects.has(key) ? { size: objects.get(key).bytes.length, customMetadata: objects.get(key).customMetadata,
      etag: objects.get(key).etag ?? hash(objects.get(key).bytes), checksums: { sha256: Uint8Array.from(Buffer.from(objects.get(key).sha256, 'hex')).buffer } } : null,
    get: async (key, options) => {
      const object = await bucket.head(key);
      if (!object) return null;
      return { ...object, ...(options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== object.etag
        ? {} : { body: new Response(objects.get(key).bytes).body }) };
    },
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
    GIZMAGICK_DRAFT_UPLOADS_ENABLED: 'true', GIZMAGICK_DRAFT_REVIEWS_ENABLED: 'true', GIZMAGICK_DRAFT_METADATA_ENABLED: 'true' };
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
  const normalize = value => value.replaceAll('\r\n', '\n');
  assert.equal(normalize(await read('../../worker/src/generated/manifest-validator.js')), normalize('// Generated from shared/track-manifest.schema.json; freshness is checked by tests.\n' + createManifestValidatorSource() + '\n'));
});

// Synthetic measurements exercise the human-attestation contract; they are not
// presented as decoder proof. A real decoded-file round trip is tested below.
async function readyReview(f, input = canonical()) {
  const created = await f.create(input);
  assert.equal(created.status, 201, await created.clone().text());
  const draft = await created.json();
  for (const id of Object.keys(draft.manifest.assets)) await f.upload(draft, ogg(), id);
  const jobResponse = await f.request(`/api/admin/drafts/${draft.id}/review-package`, { method: 'POST' });
  assert.equal(jobResponse.status, 200, await jobResponse.clone().text());
  const job = await jobResponse.json();
  const report = await createReviewReport(job, { trackId: draft.manifest.track.id, versionId: draft.manifest.versionId,
    decoderVersions: { opus: '1.7.5', vorbis: '0.1.20' }, valid: true, errors: [], measurements: Object.fromEntries(job.snapshot.assets.map(asset =>
      [asset.assetId, { codec: 'opus', channels: 2, sampleRate: 48000, sampleCount: 8640000,
        containerSampleCount: 8640000, initialOverlapSamples: 0, durationSeconds: 180,
        byteLength: asset.byteLength, sha256: asset.sha256 }])) });
  return { draft, job, report, attest: (body = { report, policy: REVIEW_POLICY, provenanceConfirmed: true }, principal = owner) =>
    f.request(`/api/admin/drafts/${draft.id}/attest-review`, { method: 'POST', body, principal }) };
}

const metadataInput = draft => ({ expectedManifestSha256: draft.manifestSha256, manifest: structuredClone(draft.manifest) });
const edit = (f, draft, input = metadataInput(draft), principal = owner) => f.request(`/api/admin/drafts/${draft.id}/metadata`, { method: 'POST', body: input, principal });

function enablePublicationPreview(f, head = async () => null) {
  f.env.GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED = 'true';
  f.env.GIZMAGICK_MEDIA = { head, put: () => assert.fail('A publication preview must not write public objects') };
}
const publicationPreview = (f, draft, options) => f.request(`/api/admin/drafts/${draft.id}/publication-preview`, options);

function enablePublisher(f) {
  const objects = new Map(), hooks = {};
  const bucket = {
    head: async key => {
      const stored = objects.get(key);
      return stored ? { size: stored.bytes.length, etag: stored.etag, customMetadata: stored.customMetadata,
        httpMetadata: stored.httpMetadata, checksums: { sha256: Uint8Array.from(Buffer.from(stored.sha256, 'hex')).buffer } } : null;
    },
    put: async (key, body, options) => {
      assert.equal(options.onlyIf.etagDoesNotMatch, '*');
      if (hooks.beforePut) await hooks.beforePut(key);
      if (objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (hash(bytes) !== options.sha256) throw new Error('R2 checksum mismatch');
      objects.set(key, { bytes, etag: hash(bytes), ...options });
      if (hooks.afterPut) await hooks.afterPut(key);
      return bucket.head(key);
    },
  };
  f.env.GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED = 'true';
  f.env.GIZMAGICK_PUBLICATION_ENABLED = 'true';
  f.env.GIZMAGICK_MEDIA = bucket;
  return { objects, hooks, bucket };
}
const publicationInput = ready => ({ requestId: crypto.randomUUID(), expectedSnapshotSha256: ready.job.snapshotSha256,
  expectedReportSha256: hash(Buffer.from(JSON.stringify(ready.report))), publicationConfirmed: true });
const startPublication = (f, ready, input = publicationInput(ready), options = {}) =>
  f.request(`/api/admin/drafts/${ready.draft.id}/publication`, { method: 'POST', body: input, ...options });
const publicationStep = (f, ready, id, options = {}) => f.request(`/api/admin/drafts/${ready.draft.id}/publication-step`,
  { method: 'POST', body: { publicationId: id, publicationConfirmed: true }, ...options });
async function startedPublisher(t) {
  const f = fixture(t), ready = await readyReview(f); await ready.attest();
  const storage = enablePublisher(f), input = publicationInput(ready);
  const response = await startPublication(f, ready, input);
  assert.equal(response.status, 201, await response.clone().text());
  const { publication } = await response.json();
  return { f, ready, storage, input, publication };
}

test('publisher copies one object per step, verifies before one atomic catalog commit, and retries idempotently', async t => {
  const { f, ready, storage, input, publication } = await startedPublisher(t);
  assert.equal(publication.state, 'pending'); assert.equal(publication.totalObjects, 2);
  const statusPath = `/api/admin/drafts/${ready.draft.id}/publication`;
  const statusResponse = await f.request(statusPath);
  assert.equal(statusResponse.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(statusResponse.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await statusResponse.json()).publication.id, publication.id);
  assert.equal(await (await f.request(statusPath, { method: 'HEAD' })).text(), '');
  assert.equal((await f.request(statusPath, { principal: other })).status, 404);
  assert.equal(storage.objects.size, 0); assert.equal((await startPublication(f, ready, input)).status, 200);
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publishing, true);
  for (let count = 1; count <= 2; count++) {
    const response = await publicationStep(f, ready, publication.id);
    assert.equal(response.status, 200, await response.clone().text());
    const current = (await response.json()).publication;
    assert.equal(current.copiedObjects, count); assert.equal(current.state, 'pending');
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  }
  assert([...storage.objects.keys()][0].endsWith('.ogg')); assert([...storage.objects.keys()][1].endsWith('manifest.json'));
  const response = await publicationStep(f, ready, publication.id);
  assert.equal(response.status, 200, await response.clone().text());
  const done = (await response.json()).publication;
  assert.equal(done.state, 'published'); assert(done.publishedAt); assert.equal(done.serverDecoded, false);
  assert.equal(done.scope, 'administrator-attested'); assert.equal(done.nextAction, null);
  const track = f.sql.prepare('SELECT * FROM library_tracks').get();
  assert.equal(track.owner_id, owner.id); assert.equal(track.current_version_id, ready.draft.manifest.versionId);
  assert.equal(track.legacy_key, null); assert.equal(track.visibility, 'public');
  const catalogResponse = await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env);
  assert.equal(catalogResponse.status, 200);
  assert.equal((await catalogResponse.json()).tracks[track.id].versionId, track.current_version_id);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
  assert.equal((await startPublication(f, ready, input)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
  assert.equal(storage.objects.size, 2);
  // Private archival after publication is NOT unpublishing or a cache purge.
  await f.request(`/api/admin/drafts/${ready.draft.id}/archive`, { method: 'POST' });
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
  assert.equal(f.sql.prepare('SELECT status FROM library_tracks').get().status, 'published');
});

test('publisher requires rollout, exact review hashes, explicit confirmation, bounded inputs and owner/admin access', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest();
  assert.equal((await startPublication(f, ready)).status, 503);
  enablePublisher(f);
  for (const key of ['GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED', 'GIZMAGICK_DRAFT_REVIEWS_ENABLED']) {
    f.env[key] = 'false'; assert.equal((await startPublication(f, ready)).status, 503); f.env[key] = 'true';
  }
  assert.equal((await startPublication(f, ready, undefined, { principal: other })).status, 404);
  assert.equal((await startPublication(f, ready, undefined, { principal: { ...owner, role: 'contributor' } })).status, 403);
  for (const input of [{}, { ...publicationInput(ready), publicationConfirmed: false },
    { ...publicationInput(ready), ownerId: other.id }, { ...publicationInput(ready), requestId: 'bad' },
    { ...publicationInput(ready), requestId: [crypto.randomUUID()] },
    { ...publicationInput(ready), expectedSnapshotSha256: ['a'.repeat(64)] },
    { ...publicationInput(ready), expectedSnapshotSha256: 'bad' }]) assert.equal((await startPublication(f, ready, input)).status, 400);
  assert.equal((await startPublication(f, ready, { ...publicationInput(ready), expectedSnapshotSha256: '0'.repeat(64) })).status, 409);
  assert.equal((await startPublication(f, ready, 'invalid')).status, 415);
  assert.equal((await startPublication(f, ready, '{', { headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await startPublication(f, ready, ' '.repeat(2049), { headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/publication-step`)).status, 405);
  assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/publication`, { method: 'DELETE' })).status, 405);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

test('publisher rejects unreviewed, archived, oversized and reserved tracks before creating an intent', async t => {
  const f = fixture(t), ready = await readyReview(f); enablePublisher(f);
  assert.equal((await startPublication(f, ready)).status, 409);
  await ready.attest();
  f.sql.prepare('INSERT INTO library_tracks (id, owner_id) VALUES (?, ?)').run(ready.draft.manifest.track.id, other.id);
  assert.equal((await startPublication(f, ready)).status, 409);
  f.sql.prepare('DELETE FROM library_tracks').run();
  const oversized = structuredClone(ready.draft.manifest);
  for (let i = 0; i < 16; i++) oversized.assets[crypto.randomUUID()] = structuredClone(Object.values(oversized.assets)[0]);
  f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(oversized), ready.draft.id);
  assert.equal((await startPublication(f, ready)).status, 422);
  await f.request(`/api/admin/drafts/${ready.draft.id}/archive`, { method: 'POST' });
  assert.equal((await startPublication(f, ready)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

test('publisher refuses existing public objects, even identical bytes, without its exact durable intent', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest();
  const { objects } = enablePublisher(f);
  const key = `tracks/${ready.draft.manifest.track.id}/versions/${ready.draft.manifest.versionId}/audio/Lena's Home.ogg`;
  objects.set(key, { bytes: ogg(), sha256: hash(ogg()), etag: hash(ogg()), customMetadata: {}, httpMetadata: {} });
  assert.equal((await startPublication(f, ready)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
  objects.clear();
  const started = (await (await startPublication(f, ready)).json()).publication;
  objects.set(key, { bytes: ogg(), sha256: hash(ogg()), etag: hash(ogg()), customMetadata: {}, httpMetadata: {} });
  const response = await publicationStep(f, ready, started.id);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PUBLICATION_DESTINATION');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
});

test('publisher recovers an object after lost PUT response without overwriting, and retains exact intent on request conflicts', async t => {
  const { f, ready, storage, input, publication } = await startedPublisher(t);
  storage.hooks.afterPut = () => { throw new Error('lost response with private credentials'); };
  const failed = await publicationStep(f, ready, publication.id);
  assert.equal(failed.status, 503); assert(!(await failed.text()).includes('credentials'));
  assert.equal(storage.objects.size, 1); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
  delete storage.hooks.afterPut;
  storage.hooks.beforePut = () => assert.fail('Recovery must not overwrite the existing object');
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 1);
  assert.equal((await startPublication(f, ready, { ...input, requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await startPublication(f, ready, { ...input, expectedReportSha256: '0'.repeat(64) })).status, 409);
  assert.equal((await publicationStep(f, ready, crypto.randomUUID())).status, 404);
});

test('publication leases serialize concurrent steps and fence expired workers before receipt or pointer writes', async t => {
  const { f, ready, storage, publication } = await startedPublisher(t);
  const responses = await Promise.all([publicationStep(f, ready, publication.id), publicationStep(f, ready, publication.id)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(storage.objects.size, 1); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 1);
  f.sql.prepare("UPDATE admin_publications SET lease_token = 'crashed', lease_expires_at = unixepoch('now') + 120 WHERE id = ?").run(publication.id);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  f.sql.prepare('UPDATE admin_publications SET lease_expires_at = 0 WHERE id = ?').run(publication.id);
  storage.hooks.afterPut = () => f.sql.prepare('UPDATE admin_publications SET lease_expires_at = 0 WHERE id = ?').run(publication.id);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(storage.objects.size, 2); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 1);
  delete storage.hooks.afterPut;
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

for (const alteration of ['missing', 'etag', 'checksum', 'hash', 'review', 'metadata', 'base']) test(`publisher stops when private ${alteration} changes after intent`, async t => {
  const { f, ready, storage, publication } = await startedPublisher(t);
  const stored = f.objects.get(ready.job.snapshot.assets[0].objectKey);
  if (alteration === 'missing') f.objects.clear();
  if (alteration === 'etag') stored.etag = 'changed';
  if (alteration === 'checksum') stored.sha256 = '0'.repeat(64);
  if (alteration === 'hash') stored.customMetadata.sha256 = '0'.repeat(64);
  if (alteration === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET candidate_json = '{}' WHERE draft_id = ?").run(ready.draft.id);
  if (alteration === 'metadata') {
    const changed = structuredClone(ready.draft.manifest); changed.track.title += '!';
    f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(changed), ready.draft.id);
  }
  if (alteration === 'base') f.env.GIZMAGICK_MEDIA_BASE_URL = 'https://other.example.com';
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(storage.objects.size, 0); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

test('conditional source reads and native PUT checksums stop changes between inspection and copying', async t => {
  const { f, ready, storage, publication } = await startedPublisher(t);
  const originalGet = f.env.GIZMAGICK_DRAFTS.get, source = f.objects.get(ready.job.snapshot.assets[0].objectKey);
  f.env.GIZMAGICK_DRAFTS.get = async (key, options) => {
    assert.equal(options.onlyIf.etagMatches, ready.job.snapshot.assets[0].etag);
    source.etag = 'changed-after-head';
    return originalGet(key, options);
  };
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(storage.objects.size, 0);
  delete source.etag;
  f.env.GIZMAGICK_DRAFTS.get = async (key, options) => ({ ...(await originalGet(key, options)), body: new Response(ogg(9)).body });
  assert.equal((await publicationStep(f, ready, publication.id)).status, 503);
  assert.equal(storage.objects.size, 0);
});

for (const alteration of ['missing', 'etag', 'checksum', 'intent', 'plan', 'type']) test(`final publication refuses a public object with changed ${alteration}`, async t => {
  const { f, ready, storage, publication } = await startedPublisher(t);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
  const [key, stored] = [...storage.objects][0];
  if (alteration === 'missing') storage.objects.delete(key);
  if (alteration === 'etag') stored.etag = 'changed';
  if (alteration === 'checksum') stored.sha256 = '0'.repeat(64);
  if (alteration === 'intent') stored.customMetadata.gizmagickPublication = crypto.randomUUID();
  if (alteration === 'plan') stored.customMetadata.gizmagickPlan = '0'.repeat(64);
  if (alteration === 'type') stored.httpMetadata.contentType = 'text/html';
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
});

test('archival stops pending publication, including a race immediately before atomic commit', async t => {
  const { f, ready, publication } = await startedPublisher(t);
  await publicationStep(f, ready, publication.id); await publicationStep(f, ready, publication.id);
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_publication_commits')) return statement;
    return { bind: (...values) => ({ run: async () => {
      f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(ready.draft.id);
      return statement.bind(...values).run();
    } }) };
  };
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  assert.equal(f.sql.prepare('SELECT state FROM admin_publications').get().state, 'pending');
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
});

test('atomic publication rolls back library/audit changes when a trigger fails after the track INSERT', async t => {
  const { f, ready, publication } = await startedPublisher(t);
  await publicationStep(f, ready, publication.id); await publicationStep(f, ready, publication.id);
  f.sql.exec("CREATE TRIGGER simulate_version_failure BEFORE INSERT ON library_track_versions BEGIN SELECT RAISE(ABORT, 'database failure'); END;");
  assert.equal((await publicationStep(f, ready, publication.id)).status, 503);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  f.sql.exec('DROP TRIGGER simulate_version_failure;');
  assert.equal((await publicationStep(f, ready, publication.id)).status, 200);
});

test('publication intents/receipts/commits and published versions cannot be rewritten or deleted', async t => {
  const { f, ready, publication } = await startedPublisher(t);
  assert.throws(() => f.sql.prepare("UPDATE admin_publications SET plan_json = '{}' WHERE id = ?").run(publication.id), /immutable/);
  assert.throws(() => f.sql.prepare("UPDATE admin_publications SET state = 'published' WHERE id = ?").run(publication.id), /atomic commit/);
  assert.throws(() => f.sql.prepare('DELETE FROM admin_publications').run(), /retained/);
  await publicationStep(f, ready, publication.id); await publicationStep(f, ready, publication.id); await publicationStep(f, ready, publication.id);
  for (const table of ['admin_publication_objects', 'admin_publication_commits']) {
    assert.throws(() => f.sql.prepare(`DELETE FROM ${table}`).run(), /retained/);
  }
  assert.throws(() => f.sql.prepare("UPDATE admin_publication_objects SET etag = 'forged'").run(), /immutable/);
  assert.throws(() => f.sql.prepare("UPDATE admin_publication_commits SET lease_token = 'forged'").run(), /immutable/);
  assert.throws(() => f.sql.prepare('UPDATE admin_publications SET lease_expires_at = 0').run(), /immutable/);
  assert.throws(() => f.sql.prepare("UPDATE library_track_versions SET title = 'forged'").run(), /immutable/);
});

test('disabled publisher does not require migration 0004 and leaves existing private intake/preflight usable', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest(); enablePublicationPreview(f);
  f.sql.exec('DROP TABLE admin_publication_commits; DROP TABLE admin_publication_objects; DROP TABLE admin_publications;');
  assert.equal((await startPublication(f, ready)).status, 503);
  assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/publication`)).status, 503);
  assert.equal((await publicationPreview(f, ready.draft)).status, 200);
});

test('16-file publication stays bounded per step and publishes all declared assets before the manifest', async t => {
  const f = fixture(t), input = canonical();
  for (let i = 1; i < 16; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/variant-${i}.ogg` };
  const ready = await readyReview(f, input); await ready.attest();
  const storage = enablePublisher(f);
  let calls = 0, maxCalls = 0;
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => { calls++; return prepare(query); };
  for (const bucket of [f.env.GIZMAGICK_DRAFTS, storage.bucket]) for (const method of ['head', 'get', 'put']) {
    if (!bucket[method]) continue;
    const original = bucket[method]; bucket[method] = (...args) => { calls++; return original(...args); };
  }
  const started = await startPublication(f, ready);
  assert.equal(started.status, 201, await started.clone().text());
  const publication = (await started.json()).publication; maxCalls = calls; calls = 0;
  for (let i = 0; i < 18; i++) {
    const response = await publicationStep(f, ready, publication.id);
    assert.equal(response.status, 200, await response.clone().text());
    maxCalls = Math.max(maxCalls, calls); calls = 0;
  }
  assert(maxCalls < 50, `Bounded fixture exceeded its conservative operation budget: ${maxCalls}`);
  assert.equal(storage.objects.size, 17);
  assert.equal([...storage.objects.keys()].at(-1).endsWith('manifest.json'), true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 17);
  assert.equal(f.sql.prepare('SELECT state FROM admin_publications').get().state, 'published');
});

for (const alteration of ['review', 'job', 'allocation', 'identity', 'lease']) test(`atomic commit rejects a ${alteration} race after final R2 inspections`, async t => {
  const { f, ready, publication } = await startedPublisher(t);
  await publicationStep(f, ready, publication.id); await publicationStep(f, ready, publication.id);
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_publication_commits')) return statement;
    return { bind: (...values) => ({ run: async () => {
      if (alteration === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET report_json = '{}' WHERE draft_id = ?").run(ready.draft.id);
      if (alteration === 'job') f.sql.prepare("UPDATE admin_draft_review_jobs SET snapshot_json = '{}' WHERE draft_id = ?").run(ready.draft.id);
      if (alteration === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET object_key = object_key || 'changed' WHERE draft_id = ?").run(ready.draft.id);
      if (alteration === 'identity') f.sql.prepare('INSERT INTO library_tracks (id, owner_id) VALUES (?, ?)').run(ready.draft.manifest.track.id, other.id);
      if (alteration === 'lease') f.sql.prepare("UPDATE admin_publications SET lease_token = 'new-worker' WHERE id = ?").run(publication.id);
      return statement.bind(...values).run();
    } }) };
  };
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  assert.equal(f.sql.prepare('SELECT state FROM admin_publications').get().state, 'pending');
  if (alteration === 'identity') assert.equal(f.sql.prepare('SELECT owner_id FROM library_tracks').get().owner_id, other.id);
  else assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

test('archival during conditional public copying retains possible public bytes but cannot publish a catalog pointer', async t => {
  const { f, ready, storage, publication } = await startedPublisher(t);
  storage.hooks.afterPut = () => f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(ready.draft.id);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
  assert.equal(storage.objects.size, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  assert.equal((await publicationStep(f, ready, publication.id)).status, 409);
});

test('archival immediately before intent reservation prevents a durable intent and any copy', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest();
  const storage = enablePublisher(f), prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_publications')) return statement;
    return { bind: (...values) => ({ run: async () => {
      f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(ready.draft.id);
      return statement.bind(...values).run();
    } }) };
  };
  assert.equal((await startPublication(f, ready)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
  assert.equal(storage.objects.size, 0);
});

test('publication preflight reconstructs an attested candidate and performs no database or object writes', async t => {
  const f = fixture(t), ready = await readyReview(f);
  assert.equal((await ready.attest()).status, 201);
  enablePublicationPreview(f);
  const before = f.sql.prepare('SELECT total_changes() n').get().n, objectsBefore = [...f.objects.entries()];
  const response = await publicationPreview(f, ready.draft);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const preview = await response.json();
  assert.equal(preview.checksPassed, true); assert.equal(preview.pointInTimeOnly, true);
  assert.equal(preview.publicationAuthorized, false); assert.equal(preview.publishing, false); assert.equal(preview.serverDecoded, false);
  assert.equal(preview.scope, 'administrator-attested'); assert.equal(preview.ownerId, owner.id);
  assert.equal(preview.objects.length, 2);
  assert.equal(preview.objects[0].key, `tracks/${ready.draft.manifest.track.id}/versions/${ready.draft.manifest.versionId}/manifest.json`);
  assert.equal(preview.objects[1].byteLength, 47); assert.equal(preview.objects[1].sha256, ready.job.snapshot.assets[0].sha256);
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual([...f.objects.entries()], objectsBefore);
  assert.equal((await publicationPreview(f, ready.draft, { method: 'HEAD' })).status, 200);
  assert.equal(await (await publicationPreview(f, ready.draft, { method: 'HEAD' })).text(), '');
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publicationPreflight, true);
});

test('publication preflight is disabled by default and rejects writes, other owners, and contributor roles', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest();
  assert.equal((await publicationPreview(f, ready.draft)).status, 503);
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publicationPreflight, false);
  enablePublicationPreview(f);
  assert.equal((await publicationPreview(f, ready.draft, { principal: other })).status, 404);
  assert.equal((await publicationPreview(f, ready.draft, { principal: { ...owner, role: 'contributor' } })).status, 403);
  const write = await publicationPreview(f, ready.draft, { method: 'POST', body: { publishing: true } });
  assert.equal(write.status, 405); assert.equal(write.headers.get('Allow'), 'GET, HEAD');
  for (const key of ['GIZMAGICK_DRAFT_REVIEWS_ENABLED', 'GIZMAGICK_DRAFT_UPLOADS_ENABLED']) {
    f.env[key] = 'false'; assert.equal((await publicationPreview(f, ready.draft)).status, 503); f.env[key] = 'true';
  }
  for (const key of ['GIZMAGICK_DB', 'GIZMAGICK_DRAFTS', 'GIZMAGICK_MEDIA']) {
    const saved = f.env[key]; delete f.env[key];
    assert.equal((await publicationPreview(f, ready.draft)).status, 503); f.env[key] = saved;
  }
  f.env.GIZMAGICK_MEDIA = f.env.GIZMAGICK_DRAFTS;
  assert.equal((await publicationPreview(f, ready.draft)).status, 503);
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publicationPreflight, false);
});

test('publication preflight requires an active attested draft and retains expired-package historical reviews', async t => {
  const f = fixture(t), ready = await readyReview(f); enablePublicationPreview(f);
  assert.equal((await publicationPreview(f, ready.draft)).status, 409);
  await ready.attest();
  f.sql.prepare('UPDATE admin_draft_review_jobs SET expires_at = 0 WHERE draft_id = ?').run(ready.draft.id);
  assert.equal((await publicationPreview(f, ready.draft)).status, 200);
  await f.request(`/api/admin/drafts/${ready.draft.id}/archive`, { method: 'POST' });
  const response = await publicationPreview(f, ready.draft);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PUBLICATION_PREFLIGHT_ARCHIVED');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 1);
});

for (const alteration of ['manifest', 'snapshot', 'report', 'candidate', 'approver', 'policy', 'scope']) {
  test(`publication preflight rejects altered stored ${alteration}`, async t => {
    const f = fixture(t), ready = await readyReview(f); await ready.attest(); enablePublicationPreview(f);
    if (alteration === 'manifest') {
      const modified = structuredClone(ready.draft.manifest); modified.track.title += ' changed';
      f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(modified), ready.draft.id);
    } else if (alteration === 'snapshot') {
      const modified = structuredClone(ready.job.snapshot); modified.manifest.track.title += ' changed';
      f.sql.prepare('UPDATE admin_draft_review_jobs SET snapshot_json = ? WHERE draft_id = ?').run(JSON.stringify(modified), ready.draft.id);
    } else if (alteration === 'report' || alteration === 'candidate') {
      const column = alteration === 'report' ? 'report_json' : 'candidate_json';
      const stored = JSON.parse(f.sql.prepare(`SELECT ${column} value FROM admin_draft_reviews WHERE draft_id = ?`).get(ready.draft.id).value);
      if (alteration === 'report') stored.measurements[Object.keys(stored.measurements)[0]].durationSeconds = 181;
      else stored.track.title += ' forged';
      f.sql.prepare(`UPDATE admin_draft_reviews SET ${column} = ? WHERE draft_id = ?`).run(JSON.stringify(stored), ready.draft.id);
    } else if (alteration === 'approver') {
      f.sql.prepare('UPDATE admin_draft_reviews SET approved_by = ? WHERE draft_id = ?').run(other.id, ready.draft.id);
    } else {
      // CHECK constraints normally prevent these; simulate corrupted storage.
      f.sql.exec('PRAGMA ignore_check_constraints = ON;');
      f.sql.prepare(`UPDATE admin_draft_reviews SET ${alteration} = 'forged' WHERE draft_id = ?`).run(ready.draft.id);
    }
    assert.equal((await publicationPreview(f, ready.draft)).status, 409);
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  });
}

for (const alteration of ['missing', 'etag', 'checksum']) test(`publication preflight rejects a private object with ${alteration}`, async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest(); enablePublicationPreview(f);
  const key = ready.job.snapshot.assets[0].objectKey, stored = f.objects.get(key);
  if (alteration === 'missing') f.objects.delete(key);
  else if (alteration === 'etag') stored.etag = 'changed-etag';
  else stored.sha256 = '0'.repeat(64);
  assert.equal((await publicationPreview(f, ready.draft)).status, 409);
});

test('publication preflight rejects reserved library identities and public object collisions without overwrites', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest(); enablePublicationPreview(f);
  f.sql.prepare('INSERT INTO library_tracks (id, owner_id) VALUES (?, ?)').run(ready.draft.manifest.track.id, other.id);
  let response = await publicationPreview(f, ready.draft);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PUBLICATION_PREFLIGHT_IDENTITY');
  f.sql.prepare('DELETE FROM library_tracks WHERE id = ?').run(ready.draft.manifest.track.id);
  for (const suffix of ['manifest.json', "audio/Lena's Home.ogg"]) {
    enablePublicationPreview(f, async key => key.endsWith(suffix) ? { size: 1 } : null);
    response = await publicationPreview(f, ready.draft);
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PUBLICATION_PREFLIGHT_DESTINATION');
  }
});

test('publication preflight detects archival during inspections and hides storage errors', async t => {
  const f = fixture(t), ready = await readyReview(f); await ready.attest();
  enablePublicationPreview(f, async () => { f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(ready.draft.id); return null; });
  assert.equal((await publicationPreview(f, ready.draft)).status, 409);
  f.sql.prepare("UPDATE admin_drafts SET status = 'draft' WHERE id = ?").run(ready.draft.id);
  enablePublicationPreview(f, async () => { throw new Error('private storage credentials'); });
  const response = await publicationPreview(f, ready.draft);
  assert.equal(response.status, 503); assert(!(await response.text()).includes('credentials'));
});

test('private metadata editing validates and persists musical changes without reuploading or publishing audio', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  assert.equal(draft.metadataEditable, true);
  await f.upload(draft);
  const before = [...f.objects.entries()], input = metadataInput(draft);
  input.manifest.track.title = 'Edited private title';
  Object.values(input.manifest.sections)[0].buttonLabel = 'New button';
  Object.values(input.manifest.clips)[0].loopPoint = 179;
  const response = await edit(f, draft, input);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.title, 'Edited private title');
  assert.equal(saved.manifest.versionId, draft.manifest.versionId);
  assert.notEqual(saved.manifestSha256, draft.manifestSha256);
  assert.equal(saved.missingAssets.length, 0);
  assert.equal(saved.audioProbed, false); assert.equal(saved.publishing, false);
  assert.deepEqual([...f.objects.entries()], before);
  assert.equal((await (await f.request(`/api/admin/drafts/${draft.id}`)).json()).manifestSha256, saved.manifestSha256);
  assert.equal((await edit(f, draft, input)).status, 200); // Lost-response retry.
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
});

test('metadata editing fails closed when disabled, review tables are absent, or identity is not the owner/admin', async t => {
  const f = fixture(t), draft = await (await f.create()).json();
  assert.equal((await edit(f, draft, metadataInput(draft), other)).status, 404);
  assert.equal((await edit(f, draft, metadataInput(draft), { ...owner, role: 'contributor' })).status, 403);
  f.env.GIZMAGICK_DRAFT_METADATA_ENABLED = 'false';
  assert.equal((await edit(f, draft)).status, 503);
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.metadata, false);
  f.env.GIZMAGICK_DRAFT_METADATA_ENABLED = 'true'; f.env.GIZMAGICK_DRAFT_REVIEWS_ENABLED = 'false';
  f.sql.exec('DROP TABLE admin_draft_reviews; DROP TABLE admin_draft_review_jobs;');
  assert.equal((await edit(f, draft)).status, 503);
  assert.equal((await (await f.request(`/api/admin/drafts/${draft.id}`)).json()).metadataEditable, false);
});

for (const [name, mutate] of [
  ['track identity', input => { input.manifest.track.id = crypto.randomUUID(); }],
  ['version identity', input => { input.manifest.versionId = crypto.randomUUID(); }],
  ['asset path', input => { Object.values(input.manifest.assets)[0].path = 'audio/different.ogg'; }],
  ['asset fingerprint', input => { Object.values(input.manifest.assets)[0].sha256 = 'a'.repeat(64); }],
  ['asset duration constraint', input => { Object.values(input.manifest.assets)[0].durationSeconds = 999; }],
  ['new asset', input => { input.manifest.assets.extra = { path: 'audio/extra.ogg' }; }],
  ['broken graph', input => { input.manifest.track.firstSection = 'does not exist'; }],
  ['forged ownership', input => { input.ownerId = other.id; }],
  ['forged approval', input => { input.manifest.serverDecoded = true; }],
  ['coerced checksum', input => { input.expectedManifestSha256 = [input.expectedManifestSha256]; }],
]) test(`metadata edits reject ${name} without touching the saved draft`, async t => {
  const f = fixture(t), draft = await (await f.create()).json(), input = metadataInput(draft);
  mutate(input);
  assert([400, 422].includes((await edit(f, draft, input)).status));
  const reopened = await (await f.request(`/api/admin/drafts/${draft.id}`)).json();
  assert.equal(reopened.manifestSha256, draft.manifestSha256);
});

test('metadata edits preserve identity despite property reordering and reject stale competing edits', async t => {
  const f = fixture(t), draft = await (await f.create()).json(), input = metadataInput(draft);
  input.manifest.assets = Object.fromEntries(Object.entries(input.manifest.assets).reverse().map(([id, asset]) => [id, Object.fromEntries(Object.entries(asset).reverse())]));
  input.manifest.track.title = 'First edit';
  assert.equal((await edit(f, draft, input)).status, 200);
  const second = metadataInput(draft); second.manifest.track.title = 'Stale overwrite';
  assert.equal((await edit(f, draft, second)).status, 409);
  assert.equal((await (await f.request(`/api/admin/drafts/${draft.id}`)).json()).title, 'First edit');
});

test('metadata edits invalidate packages/reports; a new package binds the saved graph', async t => {
  const f = fixture(t), r = await readyReview(f), input = metadataInput(r.draft);
  input.manifest.track.title = 'Changed after package';
  assert.equal((await edit(f, r.draft, input)).status, 200);
  assert.equal((await r.attest()).status, 409);
  const job = await (await f.request(`/api/admin/drafts/${r.draft.id}/review-package`, { method: 'POST' })).json();
  assert.notEqual(job.jobId, r.job.jobId);
  assert.notEqual(job.snapshotSha256, r.job.snapshotSha256);
  assert.equal(job.snapshot.manifest.track.title, 'Changed after package');
  assert.equal((await r.attest()).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('attested and archived drafts cannot be edited, including no-op retries', async t => {
  const f = fixture(t), r = await readyReview(f);
  assert.equal((await r.attest()).status, 201);
  assert.equal((await edit(f, r.draft)).status, 409);
  assert.equal((await (await f.request(`/api/admin/drafts/${r.draft.id}`)).json()).metadataEditable, false);
  const second = await (await f.create()).json();
  await f.request(`/api/admin/drafts/${second.id}/archive`, { method: 'POST' });
  assert.equal((await edit(f, second)).status, 409);
});

test('concurrent metadata save and attestation cannot both commit against the old graph', async t => {
  const f = fixture(t), r = await readyReview(f), input = metadataInput(r.draft);
  input.manifest.track.title = 'Racing save';
  const [saved, attested] = await Promise.all([edit(f, r.draft, input), r.attest()]);
  assert(!(saved.status === 200 && attested.status === 201));
  assert([200, 409].includes(saved.status)); assert([201, 409].includes(attested.status));
  const row = f.sql.prepare('SELECT * FROM admin_draft_reviews').get();
  if (row) assert.equal(JSON.parse(f.sql.prepare('SELECT manifest_json FROM admin_drafts').get().manifest_json).track.title, r.draft.title);
});

test('archival at the metadata UPDATE prevents a stale save', async t => {
  const f = fixture(t), draft = await (await f.create()).json(), input = metadataInput(draft), prepare = f.env.GIZMAGICK_DB.prepare;
  input.manifest.track.title = 'Must not save';
  f.env.GIZMAGICK_DB.prepare = query => {
    if (query.startsWith('UPDATE admin_drafts SET title')) f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
    return prepare(query);
  };
  assert.equal((await edit(f, draft, input)).status, 409);
  assert.equal(f.sql.prepare('SELECT title FROM admin_drafts').get().title, draft.title);
});

test('metadata requests bound bytes, require JSON/checksum, and advertise POST only', async t => {
  const f = fixture(t), draft = await (await f.create()).json(), path = `/api/admin/drafts/${draft.id}/metadata`;
  const get = await f.request(path); assert.equal(get.status, 405); assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal((await f.request(path, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await f.request(path, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', body: 'x'.repeat(262145), headers: { 'Content-Type': 'application/json' } })).status, 413);
  const input = metadataInput(draft); delete input.expectedManifestSha256;
  assert.equal((await edit(f, draft, input)).status, 400);
});

test('review package requires complete private audio and is retryable without multiplying stored jobs', async t => {
  const f = fixture(t), draft = await (await f.create()).json(), path = `/api/admin/drafts/${draft.id}/review-package`;
  assert.equal((await f.request(path, { method: 'POST' })).status, 409);
  await f.upload(draft);
  const first = await (await f.request(path, { method: 'POST' })).json();
  const retry = await (await f.request(path, { method: 'POST' })).json();
  assert.deepEqual(retry, first);
  assert.equal(first.snapshot.draftId, draft.id);
  assert.deepEqual(first.snapshot.manifest, draft.manifest);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_jobs').get().n, 1);
});

test('explicit administrator attestation is durable, idempotent, and never marks audio server-decoded or publishes it', async t => {
  const f = fixture(t), r = await readyReview(f);
  assert.equal((await r.attest({ report: r.report })).status, 400);
  assert.equal((await r.attest()).status, 201);
  assert.equal((await r.attest()).status, 200);
  const detail = await (await f.request(`/api/admin/drafts/${r.draft.id}`)).json();
  assert.equal(detail.review.scope, 'administrator-attested');
  assert.equal(detail.review.approvedBy, owner.id);
  assert.equal(detail.review.serverDecoded, false);
  assert.equal(detail.audioProbed, false); assert.equal(detail.publishing, false);
  assert.deepEqual(detail.manifest, r.draft.manifest);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal((await f.request(`/api/admin/drafts/${r.draft.id}/review-package`, { method: 'POST' })).status, 409);
  r.report.measurements[Object.keys(r.report.measurements)[0]].channels = 1;
  assert.equal((await r.attest()).status, 409);
});

test('owner isolation, admin-only review, origin/JWT guard routing and disabled rollout stay enforced', async t => {
  const f = fixture(t), r = await readyReview(f);
  assert.equal((await r.attest(undefined, other)).status, 404);
  assert.equal((await r.attest(undefined, { ...owner, role: 'contributor' })).status, 403);
  assert.equal((await f.request(`/api/admin/drafts/${r.draft.id}/review-package`, { method: 'POST', principal: other })).status, 404);
  assert.equal((await f.request(`/api/admin/drafts/${r.draft.id}/review-package`)).status, 405);
  f.env.GIZMAGICK_DRAFT_REVIEWS_ENABLED = 'false';
  // An old deployment without migration 0003 must still support ordinary intake.
  f.sql.exec('DROP TABLE admin_draft_reviews; DROP TABLE admin_draft_review_jobs;');
  assert.equal((await r.attest()).status, 503);
  assert.equal((await f.request(`/api/admin/drafts/${r.draft.id}`)).status, 200);
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.reviews, false);
});

for (const [name, mutate] of [
  ['wrong version', report => { report.versionId = crypto.randomUUID(); }],
  ['wrong draft', report => { report.draftId = crypto.randomUUID(); }],
  ['wrong job', report => { report.jobId = crypto.randomUUID(); }],
  ['wrong snapshot', report => { report.snapshotSha256 = '0'.repeat(64); }],
  ['wrong metadata hash', report => { report.manifestSha256 = '0'.repeat(64); }],
  ['ordinary local-only report', report => { report.scope = 'local-only'; }],
  ['failed decode', report => { report.valid = false; }],
  ['partial measurements', report => { report.measurements = {}; }],
  ['extra measurement', report => { report.measurements.extra = {}; }],
  ['client trust flag', report => { report.audioProbed = true; }],
  ['wrong decoder', report => { report.decoderVersions.opus = '0.0.0'; }],
  ['mismatched bytes', report => { Object.values(report.measurements)[0].sha256 = '0'.repeat(64); }],
  ['inconsistent samples', report => { Object.values(report.measurements)[0].sampleCount++; }],
  ['unsupported codec', report => { Object.values(report.measurements)[0].codec = 'mp3'; }],
  ['non-finite duration', report => { Object.values(report.measurements)[0].durationSeconds = null; }],
  ['unsupported channels', report => { Object.values(report.measurements)[0].channels = 6; }],
  ['unknown measurement fields', report => { Object.values(report.measurements)[0].trusted = true; }],
  ['duration past clip endpoint', report => { const m = Object.values(report.measurements)[0]; m.durationSeconds = 1; m.sampleCount = m.containerSampleCount = 48000; }],
]) test(`review rejects ${name} without recording an attestation`, async t => {
  const f = fixture(t), r = await readyReview(f); mutate(r.report);
  assert([409, 422].includes((await r.attest()).status));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

for (const state of ['expired', 'archived', 'metadata', 'missing object', 'etag', 'checksum', 'allocation']) test(`review rejects ${state} snapshots`, async t => {
  const f = fixture(t), r = await readyReview(f), key = [...f.objects.keys()][0];
  if (state === 'expired') f.sql.prepare('UPDATE admin_draft_review_jobs SET expires_at = 0').run();
  if (state === 'archived') await f.request(`/api/admin/drafts/${r.draft.id}/archive`, { method: 'POST' });
  if (state === 'metadata') { const m = structuredClone(r.draft.manifest); m.track.title += '!'; f.sql.prepare('UPDATE admin_drafts SET manifest_json = ?').run(JSON.stringify(m)); }
  if (state === 'missing object') f.objects.delete(key);
  if (state === 'etag') f.objects.get(key).etag = 'different';
  if (state === 'checksum') f.objects.get(key).sha256 = '0'.repeat(64);
  if (state === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
  assert.equal((await r.attest()).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('expired packages renew in place and old reports cannot approve the replacement job', async t => {
  const f = fixture(t), r = await readyReview(f);
  f.sql.prepare('UPDATE admin_draft_review_jobs SET expires_at = 0').run();
  const next = await (await f.request(`/api/admin/drafts/${r.draft.id}/review-package`, { method: 'POST' })).json();
  assert.notEqual(next.jobId, r.job.jobId);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_jobs').get().n, 1);
  assert.equal((await r.attest()).status, 409);
});

test('concurrent same-report confirmations converge on one audit record', async t => {
  const f = fixture(t), r = await readyReview(f);
  const responses = await Promise.all([r.attest(), r.attest()]);
  assert(responses.every(response => [200, 201].includes(response.status)));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 1);
});

test('missing native R2 checksum fails closed even when custom metadata still matches', async t => {
  const f = fixture(t), r = await readyReview(f), head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = async key => ({ ...await head(key), checksums: {} });
  assert.equal((await r.attest()).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('review MIME type, bounded bodies, and extra approval fields are rejected before recording', async t => {
  const f = fixture(t), r = await readyReview(f), path = `/api/admin/drafts/${r.draft.id}/attest-review`;
  assert.equal((await f.request(path, { method: 'POST', body: '{' })).status, 415);
  assert.equal((await f.request(path, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request(path, { method: 'POST', body: 'x'.repeat(264193), headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.equal((await r.attest({ report: r.report, policy: REVIEW_POLICY, provenanceConfirmed: true, approvedBy: other.id })).status, 400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('archival between snapshot read and conditional approval prevents the write', async t => {
  const f = fixture(t), r = await readyReview(f), prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    if (query.startsWith('INSERT INTO admin_draft_reviews')) f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
    return prepare(query);
  };
  assert.equal((await r.attest()).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('real Lena’s Home decoder report binds to private uploaded bytes, not repository track names', async t => {
  const f = fixture(t), draft = await (await f.create()).json(), root = new URL(`../public${entry.basePath}/`, import.meta.url);
  const bytes = new Uint8Array(await readFile(new URL("audio/Lena's Home.ogg", root)));
  assert.equal((await f.upload(draft, bytes)).status, 200);
  const job = await (await f.request(`/api/admin/drafts/${draft.id}/review-package`, { method: 'POST' })).json();
  const decoded = await probeManifest(job.snapshot.manifest, fileURLToPath(root));
  const report = await createReviewReport(job, createProbeReport(job.snapshot.manifest, decoded));
  assert.equal(report.valid, true);
  const response = await f.request(`/api/admin/drafts/${draft.id}/attest-review`, { method: 'POST', body: { report, policy: REVIEW_POLICY, provenanceConfirmed: true } });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).audioProbed, false);
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
  assert(!page.includes('id="publication-panel"'));
  checkOggIntake(ogg());
});

test('publishing page controls require the complete effective server-side capability', async t => {
  const f = fixture(t); enablePublisher(f);
  let response = await f.request('/admin'), html = await response.text();
  assert(html.includes('id="publication-panel"'));
  assert(html.includes('Each copy makes a file publicly downloadable by URL'));
  assert(!html.includes('localStorage')); assert(!html.includes('innerHTML'));
  assert(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
  f.env.GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED = 'false';
  html = await (await f.request('/admin')).text();
  assert(!html.includes('id="publication-panel"'));
  f.env.GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED = 'true'; f.env.GIZMAGICK_MEDIA = f.env.GIZMAGICK_DRAFTS;
  html = await (await f.request('/admin')).text();
  assert(!html.includes('id="publication-panel"'));
});
