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
import { ORIGINAL_LIBRARY } from '../../shared/original-library.js';
import { prepareClipEnds } from '../scripts/lib/clip-end-preparation.mjs';
import { unstable_splitSqlQuery } from 'wrangler';

const owner = { id: 'access:' + 'a'.repeat(64), email: 'admin@example.com', role: 'admin' };
const other = { ...owner, id: 'access:' + 'b'.repeat(64) };
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migrations = await Promise.all(['0001_gizmagick_library.sql', '0002_gizmagick_drafts.sql', '0003_gizmagick_draft_reviews.sql', '0004_gizmagick_publications.sql', '0005_gizmagick_review_package_batches.sql', '0006_gizmagick_review_verification_batches.sql', '0007_gizmagick_publication_intents.sql', '0008_gizmagick_bounded_public_copy.sql', '0009_gizmagick_bounded_publication_final.sql', '0010_gizmagick_original_imports.sql', '0011_gizmagick_original_publication.sql'].map(name => read(`../../worker/migrations/${name}`)));
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
function fixture(t, { verificationMigration = true, intentMigration = true, copyMigration = true, finalMigration = true, originalMigration = true, originalPublicationMigration = true } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON;');
  for (const [index, migration] of migrations.entries()) if (index < 5 || (index === 5 && verificationMigration)
    || (index === 6 && verificationMigration && intentMigration) || (index === 7 && verificationMigration && intentMigration && copyMigration)
    || (index === 8 && verificationMigration && intentMigration && copyMigration && finalMigration)
    || (index === 9 && verificationMigration && intentMigration && copyMigration && finalMigration && originalMigration)
    || (index === 10 && verificationMigration && intentMigration && copyMigration && finalMigration && originalMigration && originalPublicationMigration)) sql.exec(migration);
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
  const env = { GIZMAGICK_DB: { prepare, batch: async statements => {
    sql.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } }, GIZMAGICK_DRAFTS: bucket,
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

const inspectionPath = (draft, offset = 0, pin) => `/api/admin/drafts/${draft.id}/storage-inspection?offset=${offset}${pin ? '&snapshot=' + pin : ''}`;
const originalSource = name => read(`../public${catalog[name].basePath}/manifest.json`).then(JSON.parse);
const originalInput = async (name = trackName) => ({ requestId: crypto.randomUUID(), legacyKey: name, expectedOwnerId: owner.id,
  sourceManifest: await originalSource(name), importConfirmed: true });
const importOriginal = (f, body, principal = owner) => f.request('/api/admin/original-imports', { method: 'POST', body, principal });

test('original intake allowlist pins all 13 original identities and exact checked-in snapshots', async () => {
  assert.deepEqual(ORIGINAL_LIBRARY.map(item => item.legacyKey), Object.keys(catalog));
  assert.equal(new Set(ORIGINAL_LIBRARY.map(item => item.trackId)).size, 13);
  for (const item of ORIGINAL_LIBRARY) {
    const source = await originalSource(item.legacyKey);
    assert.equal(source.track.id, item.trackId);
    assert.equal(source.versionId, item.sourceVersionId);
    assert.equal(hash(JSON.stringify(source)), item.sourceManifestSha256);
  }
});

test('original intake stays disabled by default, requires migration/admin and never probes either bucket', async t => {
  const f = fixture(t), input = await originalInput();
  const noStorage = () => assert.fail('Intake must not inspect or write storage');
  f.env.GIZMAGICK_DRAFTS.head = f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = f.env.GIZMAGICK_MEDIA.head = noStorage;
  assert.equal((await importOriginal(f, input)).status, 503);
  assert(!(await (await f.request('/admin')).text()).includes('id="original-fields"'));
  f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  assert.equal((await importOriginal(f, input, { ...owner, role: 'contributor' })).status, 403);
  assert.equal((await (await f.request('/api/admin/original-imports')).json()).expectedOwnerId, owner.id);
  assert((await (await f.request('/admin')).text()).includes('id="original-fields"'));
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.originalImports, true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  const old = fixture(t, { originalMigration: false }); old.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  assert.equal((await importOriginal(old, input)).status, 503);
  assert.equal(old.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

test('original import reserves exact private identity, fresh version and immutable provenance; retries and archive retain it', async t => {
  const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const input = await originalInput(), response = await importOriginal(f, input);
  assert.equal(response.status, 201, await response.clone().text());
  const draft = await response.json(), source = input.sourceManifest;
  assert.equal(draft.manifest.track.id, source.track.id);
  assert.notEqual(draft.manifest.versionId, source.versionId);
  assert.deepEqual(draft.manifest.assets, source.assets);
  assert.deepEqual(draft.originalImport, { legacyKey: trackName, sourceVersionId: source.versionId,
    sourceManifestSha256: hash(JSON.stringify(source)), publishingSupported: false });
  assert.equal(draft.audioProbed, false); assert.equal(draft.publishing, false); assert.equal(draft.review, null);
  assert.equal(draft.missingAssets.length, 1);
  assert.deepEqual({ ...f.sql.prepare('SELECT id, legacy_key, owner_id, visibility, status, current_version_id FROM library_tracks').get() },
    { id: source.track.id, legacy_key: trackName, owner_id: owner.id, visibility: 'private', status: 'draft', current_version_id: null });
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal(f.objects.size, 0);
  assert.equal((await (await handleLibraryRequest(new Request('https://example.com/api/library/catalog'), f.env)).json()).tracks[trackName], undefined);
  assert.equal((await importOriginal(f, input)).status, 200);
  assert.equal((await importOriginal(f, { ...input, requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await importOriginal(f, { ...input, extra: true })).status, 400);
  assert.equal((await importOriginal(f, input, other)).status, 403);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}`, { principal: other })).status, 404);
  assert.throws(() => f.sql.exec('DELETE FROM admin_original_imports'), /provenance is retained/);
  assert.throws(() => f.sql.exec("UPDATE admin_original_imports SET legacy_key = 'changed'"), /immutable/);
  assert.throws(() => f.sql.exec("UPDATE library_tracks SET owner_id = 'another'"), /immutable/);
  assert.throws(() => f.sql.exec('UPDATE admin_drafts SET original_legacy_key = NULL'), /immutable/);
  await f.request(`/api/admin/drafts/${draft.id}/archive`, { method: 'POST' });
  assert.equal((await (await importOriginal(f, input)).json()).status, 'archived');
  assert.equal((await importOriginal(f, { ...input, requestId: crypto.randomUUID() })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_original_imports').get().n, 1);
});

for (const [label, mutate, status] of [
  ['different owner', input => { input.expectedOwnerId = other.id; }, 403],
  ['unconfirmed', input => { input.importConfirmed = false; }, 400],
  ['non-string request ID', input => { input.requestId = [input.requestId]; }, 400],
  ['unknown catalog key', input => { input.legacyKey = 'unknown'; }, 422],
  ['different identity', input => { input.sourceManifest.track.id = crypto.randomUUID(); }, 422],
  ['edited snapshot', input => { input.sourceManifest.clips[trackName].clipEnd--; }, 422],
  ['client authority', input => { input.visibility = 'public'; }, 400],
]) test(`original intake rejects ${label} before any D1 reservation`, async t => {
  const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const input = await originalInput(); mutate(input);
  assert.equal((await importOriginal(f, input)).status, status);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts').get().n, 0);
});

test('original import batch rolls back identities/drafts on later failure, quotas and conflicting private drafts', async t => {
  const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const input = await originalInput();
  f.sql.exec("CREATE TRIGGER simulate_import_failure BEFORE INSERT ON admin_original_imports BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  assert.equal((await importOriginal(f, input)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts').get().n, 0);
  f.sql.exec('DROP TRIGGER simulate_import_failure;');
  const conflicting = await (await f.create()).json();
  const data = structuredClone(conflicting.manifest); data.track.id = input.sourceManifest.track.id;
  f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(data), conflicting.id);
  assert.equal((await importOriginal(f, input)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(conflicting.manifest), conflicting.id);
  for (let index = 1; index < 20; index++) assert.equal((await f.create()).status, 201);
  assert.equal((await importOriginal(f, input)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts').get().n, 20);
});

test('original key/track collisions never adopt even same-owner private library rows or smoke-test titles', async t => {
  for (const conflict of ['track', 'key']) {
    const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
    const input = await originalInput();
    f.sql.prepare('INSERT INTO library_tracks (id, legacy_key, owner_id) VALUES (?, ?, ?)').run(
      conflict === 'track' ? input.sourceManifest.track.id : crypto.randomUUID(), conflict === 'key' ? trackName : 'another-key', owner.id);
    assert.equal((await importOriginal(f, input)).status, 409);
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts').get().n, 0);
  }
});

test('Testing Time private metadata intake keeps all 129 assets and original graph with no file checks/approval', async t => {
  const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const input = await originalInput('Testing Time'), response = await importOriginal(f, input);
  assert.equal(response.status, 201, await response.clone().text());
  const draft = await response.json();
  assert.equal(Object.keys(draft.manifest.assets).length, 129);
  assert.equal(Object.keys(draft.manifest.clips).length, 162);
  assert.equal(Object.keys(draft.manifest.sections).length, 82);
  assert.equal(draft.missingAssets.length, 129); assert.equal(draft.review, null);
  assert.equal(f.objects.size, 0);
});

test('original real-audio upload, decoder review and recovery remain private; every publisher is locked even if flags are on', async t => {
  const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const draft = await (await importOriginal(f, await originalInput())).json();
  const root = new URL(`../public${entry.basePath}/`, import.meta.url);
  assert.equal((await f.upload(draft, new Uint8Array(await readFile(new URL("audio/Lena's Home.ogg", root))))).status, 200);
  const job = await (await f.request(`/api/admin/drafts/${draft.id}/review-package`, { method: 'POST' })).json();
  const decoded = await probeManifest(job.snapshot.manifest, fileURLToPath(root));
  const report = await createReviewReport(job, createProbeReport(job.snapshot.manifest, decoded));
  assert.equal(report.valid, true);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/attest-review`, { method: 'POST', body: { report, policy: REVIEW_POLICY, provenanceConfirmed: true } })).status, 201);
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED', 'GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED',
    'GIZMAGICK_PUBLICATION_INTENTS_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED']) f.env[flag] = 'true';
  for (const operation of ['publication', 'publication-step', 'publication-preview', 'publication-intent', 'publication-final']) {
    const response = await f.request(`/api/admin/drafts/${draft.id}/${operation}`, { method: 'POST', body: {} });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'ORIGINAL_PRIVATE_ONLY');
  }
  f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'false';
  const reloaded = await (await f.request(`/api/admin/drafts/${draft.id}`)).json();
  assert.equal(reloaded.originalImport.legacyKey, trackName);
  assert(reloaded.review);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});
const packageRequest = (f, draft, operation = 'batches', body, options = {}) => f.request(`/api/admin/drafts/${draft.id}/review-package-${operation}`,
  { ...(body !== undefined ? { method: 'POST', body } : {}), ...options });
const verifyRequest = (f, draft, operation = 'review-verification', body, options = {}) => f.request(`/api/admin/drafts/${draft.id}/${operation}`,
  { ...(body !== undefined ? { method: 'POST', body } : {}), ...options });
const verifyBegin = report => ({ report, policy: REVIEW_POLICY, provenanceConfirmed: true });
const verifyFinish = id => ({ verificationId: id, policy: REVIEW_POLICY, provenanceConfirmed: true, batchWindowConfirmed: true });
const intentRequest = (f, draft, body, options = {}) => f.request(`/api/admin/drafts/${draft.id}/publication-intent`,
  { ...(body !== undefined ? { method: 'POST', body } : {}), ...options });
const intentInput = ready => ({ action: 'prepare', requestId: crypto.randomUUID(), expectedSnapshotSha256: ready.job.snapshotSha256,
  expectedReportSha256: hash(Buffer.from(JSON.stringify(ready.report))) });
const reserveInput = prep => ({ action: 'reserve', preparationId: prep.id, publicationConfirmed: true, batchWindowConfirmed: true });
const enableIntents = f => { enablePublicationPreview(f); f.env.GIZMAGICK_PUBLICATION_INTENTS_ENABLED = 'true'; };
const finalRequest = (f, draft, body, options = {}) => f.request(`/api/admin/drafts/${draft.id}/publication-final`,
  { ...(body !== undefined ? { method: 'POST', body } : {}), ...options });
const finalStart = intent => ({ action: 'start', publicationId: intent.id, expectedPlanSha256: intent.planSha256, requestId: crypto.randomUUID() });
const finalBatch = (intent, pass, offset = 0) => ({ action: 'check-batch', publicationId: intent.id, expectedPlanSha256: intent.planSha256, passId: pass.id, offset });
const finalCommit = (intent, pass) => ({ action: 'commit', publicationId: intent.id, expectedPlanSha256: intent.planSha256, passId: pass.id, publicationConfirmed: true, batchWindowConfirmed: true });
// Contract-only measurements are never presented as decoder evidence.
async function syntheticReport(job) {
  return createReviewReport(job, { trackId: job.snapshot.manifest.track.id, versionId: job.snapshot.manifest.versionId,
    decoderVersions: { opus: '1.7.5', vorbis: '0.1.20' }, valid: true, errors: [], measurements: Object.fromEntries(job.snapshot.assets.map(asset => {
      const sampleCount = Math.round((job.snapshot.manifest.assets[asset.assetId].durationSeconds || 180) * 48000);
      return [asset.assetId, { codec: 'opus', channels: 2, sampleRate: 48000, sampleCount, containerSampleCount: sampleCount,
        initialOverlapSamples: 0, durationSeconds: sampleCount / 48000, byteLength: asset.byteLength, sha256: asset.sha256 }];
    })) });
}
async function uploadedDraft(f, input = canonical()) {
  const created = await f.create(input);
  assert.equal(created.status, 201, await created.clone().text());
  const draft = await created.json();
  for (const id of Object.keys(draft.manifest.assets)) {
    const uploaded = await f.upload(draft, ogg(), id);
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
  }
  return draft;
}

for (const count of [129, 256]) test(`bounded ${count}-asset intent rechecks storage/destinations, reserves only an immutable plan and cannot publish`, async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = f.env.GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED = 'true';
  const input = count === 129 ? { requestId: crypto.randomUUID(), manifest: JSON.parse(await read('../public/tracks/Testing Time/manifest.json')) } : canonical();
  if (count === 129) for (const asset of Object.values(input.manifest.assets)) { delete asset.byteLength; delete asset.sha256; }
  if (count === 256) for (let i = 1; i < count; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/extra-${i}.ogg` };
  const draft = await uploadedDraft(f, input), prepared = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  for (let offset = 0; offset < count; offset += 16) await packageRequest(f, draft, 'batch', { jobId: prepared.jobId, offset });
  const job = (await (await packageRequest(f, draft, 'finish', { jobId: prepared.jobId })).json()).package, report = await syntheticReport(job);
  const pass = (await (await verifyRequest(f, draft, undefined, verifyBegin(report))).json()).verification;
  for (let offset = 0; offset < count; offset += 16) await verifyRequest(f, draft, 'review-verification-batch', { verificationId: pass.id, offset });
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(pass.id))).status, 201);
  enableIntents(f);
  let privateHeads = 0, publicHeads = 0, databaseCalls = 0;
  const head = f.env.GIZMAGICK_DRAFTS.head, prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DRAFTS.head = key => { privateHeads++; return head(key); };
  f.env.GIZMAGICK_DB.prepare = query => { databaseCalls++; return prepare(query); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = f.env.GIZMAGICK_MEDIA.put = () => assert.fail('Intent readiness/reservation must not read bytes or write R2');
  f.env.GIZMAGICK_MEDIA.head = async () => { publicHeads++; return null; };
  const request = intentInput({ draft, job, report }), start = await intentRequest(f, draft, request);
  assert.equal(start.status, 201, await start.clone().text());
  const prep = (await start.json()).preparation;
  assert.equal(prep.checkedObjects, 0); assert.equal(privateHeads + publicHeads, 0);
  assert.equal((await intentRequest(f, draft, reserveInput(prep))).status, 409);
  for (let offset = 0; offset < count + 1; offset += 16) {
    privateHeads = 0; publicHeads = 0; databaseCalls = 0;
    const response = await intentRequest(f, draft, { action: 'check-batch', preparationId: prep.id, offset });
    assert.equal(response.status, 200, await response.clone().text());
    assert(privateHeads <= 16 && publicHeads <= 16);
    assert(privateHeads + publicHeads + databaseCalls <= 80, `Bounded fixture-operation budget exceeded: ${privateHeads + publicHeads + databaseCalls}`);
    assert.equal((await response.json()).preparation.checkedObjects, Math.min(offset + 16, count + 1));
    privateHeads = 0; publicHeads = 0;
    assert.equal((await intentRequest(f, draft, { action: 'check-batch', preparationId: prep.id, offset })).status, 200);
    assert.equal(privateHeads + publicHeads, 0);
  }
  const reserved = await intentRequest(f, draft, reserveInput(prep));
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const result = await reserved.json(); assert.equal(result.intent.id, prep.id);
  assert.equal(result.intent.storageCheckScope, 'bounded-batches'); assert.equal(result.intent.copiedObjects, 0);
  assert.equal(result.publicCopyEnabled, false); assert.equal(result.catalogCommitEnabled, false); assert.equal(result.publicationAuthorized, false);
  assert.equal((await intentRequest(f, draft, reserveInput(prep))).status, 200);
  assert.equal((await intentRequest(f, draft, request)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 1);
  for (const table of ['admin_publication_objects', 'admin_publication_commits', 'library_tracks']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.throws(() => f.sql.prepare('DELETE FROM admin_publication_intent_batches').run(), /retained/);
  assert.throws(() => f.sql.prepare('UPDATE admin_publication_intent_preparations SET expires_at = 0').run(), /retained/);
  assert.throws(() => f.sql.prepare('INSERT INTO admin_publication_objects (publication_id, ordinal, etag) VALUES (?, 0, ?)').run(prep.id, 'fake'), /Bounded copy changed/);
  // SQLite does not promise ordering between independent BEFORE triggers.
  assert.throws(() => f.sql.prepare('INSERT INTO admin_publication_commits (publication_id, lease_token) VALUES (?, ?)').run(prep.id, 'fake'), /Bounded final verification|Publication changed before commit/);
  f.env.GIZMAGICK_PUBLICATION_ENABLED = 'true';
  f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED = 'true';
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/publication`)).status, 409);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/publication-step`, { method: 'POST', body: { publicationId: prep.id, publicationConfirmed: true } })).status, 409);
});

async function preparedIntent(f) {
  const ready = await readyReview(f); await ready.attest(); enableIntents(f);
  const input = intentInput(ready), response = await intentRequest(f, ready.draft, input);
  assert.equal(response.status, 201, await response.clone().text());
  return { ...ready, input, preparation: (await response.json()).preparation };
}

test('planning-only compatibility reserves a bounded review without enabling any public write', async t => {
  const f = fixture(t), config = await read('../../worker/wrangler.toml');
  Object.assign(f.env, Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+)\s*=\s*"([^"]*)"/gm)]
    .map(([, name, value]) => [name, value])));
  assert.equal(f.env.GIZMAGICK_PUBLICATION_INTENTS_ENABLED, 'true');
  // Closed-write compatibility; the active final configuration is guarded separately.
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED']) {
    assert.equal(f.env[flag], 'false');
  }
  const ready = await readyReview(f);
  const pass = (await (await verifyRequest(f, ready.draft, undefined, verifyBegin(ready.report))).json()).verification;
  assert.equal((await verifyRequest(f, ready.draft, 'review-verification-batch', { verificationId: pass.id, offset: 0 })).status, 200);
  assert.equal((await verifyRequest(f, ready.draft, 'attest-review-batched', verifyFinish(pass.id))).status, 201);
  enablePublicationPreview(f);
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = () => assert.fail('Readiness never reads audio bytes or writes private files');
  const html = await (await f.request('/admin')).text();
  assert(html.includes('id="intent-panel"'));
  for (const id of ['publication-panel', 'intent-copy', 'intent-copy-confirm', 'final-panel']) assert(!html.includes(`id="${id}"`));
  const prepared = await intentRequest(f, ready.draft, intentInput(ready));
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const prep = (await prepared.json()).preparation;
  assert.equal((await intentRequest(f, ready.draft, { action: 'check-batch', preparationId: prep.id, offset: 0 })).status, 200);
  const reserved = await intentRequest(f, ready.draft, reserveInput(prep));
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const result = await reserved.json();
  assert.equal(result.intent.copiedObjects, 0); assert.equal(result.intent.storageCheckScope, 'bounded-batches');
  assert.equal(result.publicCopyEnabled, false); assert.equal(result.catalogCommitEnabled, false);
  assert.equal(result.intent.nextAction, null); assert.equal(result.intent.continuationBlocked, true);
  assert.equal((await intentRequest(f, ready.draft, { action: 'copy-one', publicationId: prep.id,
    expectedPlanSha256: result.intent.planSha256, ordinal: 0, publicationConfirmed: true })).status, 503);
  assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/publication-step`, {
    method: 'POST', body: { publicationId: prep.id, publicationConfirmed: true },
  })).status, 503);
  assert.equal((await finalRequest(f, ready.draft, finalStart(result.intent))).status, 503);
  for (const table of ['admin_publication_objects', 'admin_publication_commits', 'admin_publication_final_passes', 'library_tracks', 'library_track_versions']) {
    assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
});

async function copyReady(t, { count = 1, copyMigration = true, boundedReview = false, finalMigration = true, originalMigration = true } = {}) {
  const f = fixture(t, { copyMigration, finalMigration, originalMigration });
  let input = canonical();
  if (count === 129) {
    input = { requestId: crypto.randomUUID(), manifest: JSON.parse(await read('../public/tracks/Testing Time/manifest.json')) };
    for (const asset of Object.values(input.manifest.assets)) { delete asset.byteLength; delete asset.sha256; }
  } else for (let i = 1; i < count; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/copy-${i}.ogg` };
  const ready = await readyReview(f, input);
  if (boundedReview) {
    f.env.GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED = 'true';
    const pass = (await (await verifyRequest(f, ready.draft, undefined, verifyBegin(ready.report))).json()).verification;
    for (let offset = 0; offset < count; offset += 16) assert.equal((await verifyRequest(f, ready.draft, 'review-verification-batch', { verificationId: pass.id, offset })).status, 200);
    assert.equal((await verifyRequest(f, ready.draft, 'attest-review-batched', verifyFinish(pass.id))).status, 201);
  } else assert.equal((await ready.attest()).status, 201);
  enableIntents(f);
  const prep = (await (await intentRequest(f, ready.draft, intentInput(ready))).json()).preparation;
  for (let offset = 0; offset < count + 1; offset += 16) assert.equal((await intentRequest(f, ready.draft, { action: 'check-batch', preparationId: prep.id, offset })).status, 200);
  const reserved = await intentRequest(f, ready.draft, reserveInput(prep));
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const intent = (await reserved.json()).intent, storage = enablePublisher(f);
  f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = 'true';
  const body = ordinal => ({ action: 'copy-one', publicationId: intent.id, expectedPlanSha256: intent.planSha256, ordinal, publicationConfirmed: true });
  const copy = (ordinal = 0, options = {}) => intentRequest(f, ready.draft, body(ordinal), options);
  return { f, ready, intent, storage, body, copy };
}

async function finalReady(t, options = {}) {
  const r = await copyReady(t, options);
  for (let ordinal = 0; ordinal < r.intent.totalObjects; ordinal++) assert.equal((await r.copy(ordinal)).status, 200);
  r.f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'true';
  const input = finalStart(r.intent), started = await finalRequest(r.f, r.ready.draft, input);
  if (options.finalMigration === false) { assert.equal(started.status, 503); return { ...r, input }; }
  assert.equal(started.status, 201, await started.clone().text());
  return { ...r, input, pass: (await started.json()).verification };
}

const originalDecodes = new Map();
async function reviewedOriginal(t, { name = trackName, originalPublicationMigration = true, reviewScope = 'bounded-batches', expirePackageAfterApproval = false } = {}) {
  const f = fixture(t, { originalPublicationMigration }); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const input = await originalInput(name), created = await importOriginal(f, input);
  assert.equal(created.status, 201, await created.clone().text());
  const draft = await created.json(), root = new URL(`../public${catalog[name].basePath}/`, import.meta.url);
  for (const [id, asset] of Object.entries(draft.manifest.assets)) {
    const result = await f.upload(draft, new Uint8Array(await readFile(new URL(asset.path, root))), id);
    assert.equal(result.status, 200, await result.clone().text());
  }
  f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = f.env.GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED = 'true';
  const prep = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  for (let offset = 0; offset < Object.keys(draft.manifest.assets).length; offset += 16) {
    assert.equal((await packageRequest(f, draft, 'batch', { jobId: prep.jobId, offset })).status, 200);
  }
  const job = (await (await packageRequest(f, draft, 'finish', { jobId: prep.jobId })).json()).package;
  // Actual decoded repository bytes; repeated isolated jobs bind those exact
  // measurements to new packages. This automated fixture is NOT a human/cloud attestation.
  if (!originalDecodes.has(name)) originalDecodes.set(name, probeManifest(input.sourceManifest, fileURLToPath(root)));
  const decoded = await originalDecodes.get(name);
  const report = await createReviewReport(job, createProbeReport(job.snapshot.manifest, decoded));
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  if (reviewScope === 'single-request') {
    const attested = await f.request(`/api/admin/drafts/${draft.id}/attest-review`, { method: 'POST', body: verifyBegin(report) });
    assert.equal(attested.status, 201, await attested.clone().text());
  } else {
    assert.equal(reviewScope, 'bounded-batches');
    const verification = (await (await verifyRequest(f, draft, undefined, verifyBegin(report))).json()).verification;
    for (let offset = 0; offset < Object.keys(draft.manifest.assets).length; offset += 16) {
      assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset })).status, 200);
    }
    assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id))).status, 201);
  }
  // Simulate time passing after a valid approval, never alter cloud audit data.
  if (expirePackageAfterApproval) f.sql.prepare('UPDATE admin_draft_review_jobs SET expires_at = 0 WHERE draft_id = ?').run(draft.id);
  enableIntents(f);
  const storage = enablePublisher(f);
  f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED = 'false';
  f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'true';
  return { f, storage, ready: { draft, job, report }, source: input.sourceManifest };
}
async function originalReserved(t, options) {
  const r = await reviewedOriginal(t, options), { f, ready } = r;
  const response = await intentRequest(f, ready.draft, intentInput(ready));
  assert.equal(response.status, 201, await response.clone().text());
  const prep = (await response.json()).preparation;
  for (let offset = 0; offset < Object.keys(ready.draft.manifest.assets).length + 1; offset += 16) {
    assert.equal((await intentRequest(f, ready.draft, { action: 'check-batch', preparationId: prep.id, offset })).status, 200);
  }
  const reserved = await intentRequest(f, ready.draft, reserveInput(prep));
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const intent = (await reserved.json()).intent;
  const copy = ordinal => intentRequest(f, ready.draft, { action: 'copy-one', publicationId: intent.id,
    expectedPlanSha256: intent.planSha256, ordinal, publicationConfirmed: true });
  return { ...r, intent, copy };
}
async function originalFinal(t, options) {
  const r = await originalReserved(t, options);
  for (let ordinal = 0; ordinal < r.intent.totalObjects; ordinal++) {
    const response = await r.copy(ordinal); assert.equal(response.status, 200, await response.clone().text());
  }
  const response = await finalRequest(r.f, r.ready.draft, finalStart(r.intent));
  assert.equal(response.status, 201, await response.clone().text());
  const pass = (await response.json()).verification;
  for (let offset = 0; offset < r.intent.totalObjects; offset += 16) {
    assert.equal((await finalRequest(r.f, r.ready.draft, finalBatch(r.intent, pass, offset))).status, 200);
  }
  return { ...r, pass };
}

for (const name of [trackName, 'Testing Time']) test(`original first publication preserves owner/catalog key through real decoded ${name} audio and bounded final commit`, async t => {
  const r = await originalFinal(t, { name }), { f, ready, intent, pass } = r;
  const before = f.sql.prepare('SELECT * FROM admin_original_imports').get();
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal(intent.originalImport.legacyKey, name);
  const plan = JSON.parse(f.sql.prepare('SELECT plan_json FROM admin_publications').get().plan_json);
  assert.equal(plan.workflow, 'bounded-original-track');
  assert.equal(plan.originalImport.sourceManifestSha256, before.source_manifest_sha256);
  const completed = await finalRequest(f, ready.draft, finalCommit(intent, pass));
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal((await completed.json()).publication.originalImport.legacyKey, name);
  const tracks = (await (await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env)).json()).tracks;
  assert.equal(tracks[name].id, r.source.track.id); assert.equal(tracks[name].versionId, ready.draft.manifest.versionId);
  assert.equal(tracks[intent.trackId], undefined); // Original compatibility key, not a UUID alias.
  const row = f.sql.prepare('SELECT * FROM library_tracks').get();
  assert.equal(row.owner_id, owner.id); assert.equal(row.legacy_key, name); assert.equal(row.visibility, 'public');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 1);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_original_imports').get(), before);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
  f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED = 'false';
  const status = await (await intentRequest(f, ready.draft)).json();
  assert.equal(status.intent.state, 'published'); assert.equal(status.publicCopyEnabled, false);
  assert.equal(status.intent.originalImport.legacyKey, name);
});

test('original planning-only compatibility preserves an expired-package single-request review and blocks every public write', async t => {
  const r = await reviewedOriginal(t, { reviewScope: 'single-request', expirePackageAfterApproval: true }), { f, ready } = r;
  const config = await read('../../worker/wrangler.toml');
  Object.assign(f.env, Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+)\s*=\s*"([^"]*)"/gm)].map(([, key, value]) => [key, value])));
  assert.equal(f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED, 'true');
  // Original planning remains safe when the shared/copy gates are closed again.
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED']) assert.equal(f.env[flag], 'false');
  const review = f.sql.prepare('SELECT * FROM admin_draft_reviews').get();
  const source = f.sql.prepare('SELECT * FROM admin_original_imports').get();
  assert.equal(review.storage_check_scope, 'single-request');
  assert.equal(f.sql.prepare('SELECT expires_at FROM admin_draft_review_jobs').get().expires_at, 0);
  let privateHeads = 0, publicHeads = 0;
  const head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = async key => { privateHeads++; return head(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = () => assert.fail('Planning must not read audio or write private files');
  f.env.GIZMAGICK_MEDIA = { head: async () => { publicHeads++; return null; }, get: () => assert.fail('Planning must not read public audio'), put: () => assert.fail('Public writes remain disabled') };
  const html = await (await f.request('/admin')).text();
  assert(html.includes('id="intent-panel"'));
  for (const id of ['publication-panel', 'intent-copy', 'final-panel']) assert(!html.includes(`id="${id}"`));
  const detail = await (await f.request(`/api/admin/drafts/${ready.draft.id}`)).json();
  assert.equal(detail.originalImport.publishingSupported, true); assert.equal(detail.metadataEditable, false);
  const status = await intentRequest(f, ready.draft); assert.equal(status.status, 200);
  assert.equal((await status.json()).intent, null); assert.equal(privateHeads + publicHeads, 0);
  const input = intentInput(ready), prepared = await intentRequest(f, ready.draft, input);
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const prep = (await prepared.json()).preparation; assert.equal(prep.storageCheckScope, 'single-request');
  assert.equal(privateHeads + publicHeads, 0);
  const premature = await intentRequest(f, ready.draft, reserveInput(prep)); assert.equal(premature.status, 409);
  const checked = await intentRequest(f, ready.draft, { action: 'check-batch', preparationId: prep.id, offset: 0 });
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal((await checked.json()).preparation.checkedObjects, 2);
  assert.equal(privateHeads, 1); assert.equal(publicHeads, 2);
  const reserved = await intentRequest(f, ready.draft, reserveInput(prep));
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const result = await reserved.json(); assert.equal(result.intent.storageCheckScope, 'single-request');
  assert.equal(result.intent.originalImport.legacyKey, trackName);
  assert.equal(result.publicCopyEnabled, false); assert.equal(result.catalogCommitEnabled, false);
  assert.equal(result.intent.copiedObjects, 0); assert.equal(result.intent.nextAction, null);
  const recovered = await intentRequest(f, ready.draft); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).intent.id, prep.id);
  const before = privateHeads + publicHeads;
  assert.equal((await intentRequest(f, ready.draft, { action: 'copy-one', publicationId: prep.id,
    expectedPlanSha256: result.intent.planSha256, ordinal: 0, publicationConfirmed: true })).status, 503);
  assert.equal((await finalRequest(f, ready.draft, finalStart(result.intent))).status, 503);
  assert.equal((await startPublication(f, ready)).status, 409); // Originals cannot use the legacy route.
  assert.equal(privateHeads + publicHeads, before);
  for (const table of ['admin_publication_objects', 'admin_publication_commits', 'library_track_versions']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.sql.prepare('SELECT visibility FROM library_tracks').get().visibility, 'private');
  assert.equal(r.storage.objects.size, 0);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_draft_reviews').get(), review);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_original_imports').get(), source);
  f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED = 'false';
  const locked = await intentRequest(f, ready.draft); assert.equal(locked.status, 200);
  assert.equal((await locked.json()).intent.id, prep.id);
});

test('single-request original approval survives package expiry through fresh bounded copying and final publication locally', async t => {
  const r = await originalFinal(t, { reviewScope: 'single-request', expirePackageAfterApproval: true }), { f, ready, intent, pass } = r;
  const review = f.sql.prepare('SELECT * FROM admin_draft_reviews').get(), source = f.sql.prepare('SELECT * FROM admin_original_imports').get();
  assert.equal(review.storage_check_scope, 'single-request'); assert.equal(intent.storageCheckScope, 'single-request');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_verifications').get().n, 0);
  const committed = await finalRequest(f, ready.draft, finalCommit(intent, pass));
  assert.equal(committed.status, 200, await committed.clone().text());
  const catalog = await (await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env)).json();
  assert.equal(catalog.tracks[trackName].id, source.track_id); assert.equal(catalog.tracks[trackName].versionId, ready.draft.manifest.versionId);
  assert.equal(r.storage.objects.size, 2);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_draft_reviews').get(), review);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_original_imports').get(), source);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
});

test('original copy-only compatibility recovers lost copy responses without enabling catalog publication', async t => {
  const r = await originalReserved(t, { reviewScope: 'single-request', expirePackageAfterApproval: true }), { f, ready, intent, storage, copy } = r;
  const config = await read('../../worker/wrangler.toml');
  Object.assign(f.env, Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+)\s*=\s*"([^"]*)"/gm)].map(([, key, value]) => [key, value])));
  assert.equal(f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED, 'true');
  // Historical closed-write compatibility; the active final rollout is guarded separately.
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED']) assert.equal(f.env[flag], 'false');
  // Exercise the formerly authorized copy-only mode only in isolated storage.
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = 'true';
  const review = f.sql.prepare('SELECT * FROM admin_draft_reviews').get(), source = f.sql.prepare('SELECT * FROM admin_original_imports').get();
  const plan = f.sql.prepare('SELECT plan_json,plan_sha256 FROM admin_publications').get(), privateObjects = [...f.objects.entries()];
  assert.equal(review.storage_check_scope, 'single-request');
  const html = await (await f.request('/admin')).text();
  assert(html.includes('id="intent-copy"')); assert(html.includes('id="intent-copy-confirm"'));
  for (const id of ['publication-panel', 'final-panel']) assert(!html.includes(`id="${id}"`));
  const status = await intentRequest(f, ready.draft); assert.equal(status.status, 200);
  assert.equal((await status.json()).intent.copiedObjects, 0); assert.equal(storage.objects.size, 0);
  storage.hooks.afterPut = () => { throw new Error('Local fixture: lost successful PUT response'); };
  assert.equal((await copy(0)).status, 503);
  assert.equal(storage.objects.size, 1); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
  storage.hooks.afterPut = undefined;
  const recovered = await intentRequest(f, ready.draft); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).intent.copiedObjects, 0); // Status never invents a receipt or replays a copy.
  assert.equal((await copy(0)).status, 200); assert.equal(storage.objects.size, 1);
  assert.equal((await copy(0)).status, 200); assert.equal(storage.objects.size, 1); // Exact retry cannot copy the manifest.
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 1);
  assert.equal((await copy(1)).status, 200); assert.equal(storage.objects.size, 2);
  assert.equal((await copy(1)).status, 200); assert.equal(storage.objects.size, 2);
  const done = await (await intentRequest(f, ready.draft)).json();
  assert.equal(done.intent.copiedObjects, 2); assert.equal(done.intent.nextAction, null);
  assert.equal(done.intent.state, 'pending'); assert.equal(done.catalogCommitEnabled, false);
  assert.equal(done.intent.originalImport.legacyKey, trackName);
  assert.equal((await startPublication(f, ready)).status, 409);
  for (const input of [finalStart(intent), finalCommit(intent, { id: crypto.randomUUID() })]) assert.equal((await finalRequest(f, ready.draft, input)).status, 503);
  for (const table of ['admin_publication_commits', 'admin_publication_final_passes', 'library_track_versions']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.sql.prepare('SELECT visibility FROM library_tracks').get().visibility, 'private');
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_draft_reviews').get(), review);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_original_imports').get(), source);
  assert.deepEqual(f.sql.prepare('SELECT plan_json,plan_sha256 FROM admin_publications').get(), plan);
  assert.deepEqual([...f.objects.entries()], privateObjects);
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = 'false';
  for (const bucket of [f.env.GIZMAGICK_DRAFTS, f.env.GIZMAGICK_MEDIA]) bucket.head = bucket.get = bucket.put = () => assert.fail('Disabled status recovery must not access R2');
  const locked = await intentRequest(f, ready.draft); assert.equal(locked.status, 200);
  assert.equal((await locked.json()).intent.copiedObjects, 2);
  assert.equal((await copy(1)).status, 503);
});

test('completed original final rollout guards closed production writes and publishes reviewed copies only in isolation', async t => {
  const { f, ready, intent, storage, copy, source } = await originalReserved(t, { reviewScope: 'single-request', expirePackageAfterApproval: true });
  for (let ordinal = 0; ordinal < intent.totalObjects; ordinal++) assert.equal((await copy(ordinal)).status, 200);
  const config = await read('../../worker/wrangler.toml');
  Object.assign(f.env, Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+)\s*=\s*"([^"]*)"/gm)].map(([, key, value]) => [key, value])));
  assert.equal(f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED, 'true');
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED']) assert.equal(f.env[flag], 'false');
  // Cloud publication is complete. Preserve the production guard above and
  // exercise the final-enabled workflow only in isolated fixture storage.
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'true';
  const before = {};
  for (const table of ['admin_draft_reviews', 'admin_original_imports', 'admin_publication_objects']) before[table] = f.sql.prepare(`SELECT * FROM ${table}`).all();
  const plan = f.sql.prepare('SELECT plan_json,plan_sha256 FROM admin_publications').get();
  assert.equal(before.admin_draft_reviews[0].storage_check_scope, 'single-request');
  let privateHeads = 0, publicHeads = 0;
  const privateHead = f.env.GIZMAGICK_DRAFTS.head, publicHead = storage.bucket.head;
  f.env.GIZMAGICK_DRAFTS.head = key => { privateHeads++; return privateHead(key); };
  storage.bucket.head = key => { publicHeads++; return publicHead(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = storage.bucket.get = storage.bucket.put = () => assert.fail('Final rollout must not read audio bytes or write R2');
  const html = await (await f.request('/admin')).text();
  assert(html.includes('id="final-panel"')); assert(!html.includes('id="publication-panel"'));
  assert.equal((await startPublication(f, ready)).status, 409);
  const initial = await (await finalRequest(f, ready.draft)).json();
  assert.equal(initial.publication.copiedObjects, 2); assert.equal(initial.verification, null);
  const started = await finalRequest(f, ready.draft, finalStart(intent));
  assert.equal(started.status, 201, await started.clone().text());
  const pass = (await started.json()).verification;
  assert.equal(privateHeads + publicHeads, 0);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 409);
  const checked = await finalRequest(f, ready.draft, finalBatch(intent, pass));
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal((await checked.json()).verification.checkedObjects, 2);
  assert.equal(privateHeads, 1); assert.equal(publicHeads, 2);
  const batch = f.sql.prepare('SELECT * FROM admin_publication_final_batches').get();
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 200);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_publication_final_batches').get(), batch);
  for (const confirmation of ['publicationConfirmed', 'batchWindowConfirmed']) assert.equal((await finalRequest(f, ready.draft, { ...finalCommit(intent, pass), [confirmation]: false })).status, 400);
  const committed = await finalRequest(f, ready.draft, finalCommit(intent, pass));
  assert.equal(committed.status, 200, await committed.clone().text());
  assert.equal((await committed.json()).publication.state, 'published');
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 1);
  assert.equal(privateHeads, 1); assert.equal(publicHeads, 2); assert.equal(storage.objects.size, 2);
  for (const table of Object.keys(before)) assert.deepEqual(f.sql.prepare(`SELECT * FROM ${table}`).all(), before[table]);
  assert.deepEqual(f.sql.prepare('SELECT plan_json,plan_sha256 FROM admin_publications').get(), plan);
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  const recovered = await (await intentRequest(f, ready.draft)).json();
  assert.equal(recovered.intent.state, 'published'); assert.equal(recovered.intent.copiedObjects, 2); assert.equal(recovered.publicCopyEnabled, false);
  assert.equal((await finalRequest(f, ready.draft)).status, 503);
  const catalog = await (await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env)).json();
  assert.equal(catalog.tracks[trackName].id, source.track.id); assert.equal(catalog.tracks[trackName].versionId, intent.versionId);
  assert.equal(catalog.tracks[intent.trackId], undefined);
  assert.equal(f.sql.prepare('SELECT current_version_id FROM library_tracks').get().current_version_id, intent.versionId);
});

test('original publication requires its own exact opt-in and migration before storage checks or writes', async t => {
  const r = await reviewedOriginal(t);
  for (const flag of [undefined, false, 'false', 'TRUE', '']) {
    r.f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED = flag;
    assert.equal((await intentRequest(r.f, r.ready.draft, intentInput(r.ready))).status, 409);
  }
  const missing = await reviewedOriginal(t, { originalPublicationMigration: false });
  missing.f.env.GIZMAGICK_DRAFTS.head = missing.f.env.GIZMAGICK_MEDIA.head = () => assert.fail('Missing schema must fail before storage reads');
  assert.equal((await intentRequest(missing.f, missing.ready.draft, intentInput(missing.ready))).status, 503);
  assert.equal(missing.f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

for (const change of ['visibility', 'archive', 'owner', 'key']) test(`original readiness refuses changed reservation ${change} without public copying`, async t => {
  const r = await reviewedOriginal(t), { f } = r;
  if (change === 'visibility') f.sql.exec("UPDATE library_tracks SET visibility = 'public'");
  if (change === 'archive') f.sql.exec("UPDATE library_tracks SET status = 'archived'");
  if (['owner', 'key'].includes(change)) {
    f.sql.exec('DROP TRIGGER admin_original_library_identity;'); // Simulate privileged external corruption only.
    f.sql.exec(change === 'owner' ? "UPDATE library_tracks SET owner_id = 'other'" : "UPDATE library_tracks SET legacy_key = 'other'");
  }
  const result = await intentRequest(f, r.ready.draft, intentInput(r.ready));
  assert.equal(result.status, 409); assert.equal(r.storage.objects.size, 0);
});

test('original copy rechecks private reservation and fences a mapping race after public PUT', async t => {
  const r = await originalReserved(t), { f, storage } = r;
  storage.hooks.afterPut = () => f.sql.exec("UPDATE library_tracks SET visibility = 'public'");
  assert.equal((await r.copy(0)).status, 409);
  assert.equal(storage.objects.size, 1); // A failed receipt cannot recall public bytes.
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
  f.sql.exec("UPDATE library_tracks SET visibility = 'private'"); delete storage.hooks.afterPut;
  assert.equal((await r.copy(0)).status, 200); // Recover only this intent-marked object.
});

test('original atomic commit rolls back to the existing private reservation and recovers a lost successful response', async t => {
  const r = await originalFinal(t), { f, ready, intent, pass } = r;
  f.sql.exec("CREATE TRIGGER original_commit_failure BEFORE INSERT ON library_track_versions BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 503);
  assert.equal(f.sql.prepare('SELECT visibility FROM library_tracks').get().visibility, 'private');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  f.sql.exec('DROP TRIGGER original_commit_failure;');
  const run = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = run(query);
    if (!query.startsWith('INSERT INTO admin_publication_commits')) return statement;
    return { bind: (...args) => ({ run: async () => { await run(query).bind(...args).run(); throw new Error('Lost response after commit'); } }) };
  };
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 503);
  f.env.GIZMAGICK_DB.prepare = run;
  assert.equal((await (await finalRequest(f, ready.draft)).json()).publication.state, 'published');
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 1);
});

test('original SQL identity authority rejects a raw commit after reservation changes and never uses the legacy routes', async t => {
  const r = await originalReserved(t), { f, ready, intent } = r;
  for (const operation of ['publication', 'publication-step', 'publication-preview']) {
    assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/${operation}`, { method: 'POST', body: {} })).status, 409);
  }
  const plan = JSON.parse(f.sql.prepare('SELECT plan_json FROM admin_publications').get().plan_json);
  f.sql.exec("UPDATE library_tracks SET visibility = 'public'");
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_identity_authority').get().n, 0);
  assert.throws(() => f.sql.prepare('INSERT INTO admin_publication_commits (publication_id, lease_token) VALUES (?, ?)').run(intent.id, 'forged'), /Publication changed|Bounded final/);
  assert.equal(plan.originalImport.legacyKey, trackName);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
});

for (const forgery of ['legacy', 'new-track', 'catalog-key']) test(`original SQL intent guard rejects ${forgery} plan substitution even with recent preparation`, async t => {
  const r = await reviewedOriginal(t), { f, ready } = r;
  const response = await intentRequest(f, ready.draft, intentInput(ready)), prep = (await response.json()).preparation;
  assert.equal((await intentRequest(f, ready.draft, { action: 'check-batch', preparationId: prep.id, offset: 0 })).status, 200);
  const record = f.sql.prepare('SELECT * FROM admin_publication_intent_preparations').get(), plan = JSON.parse(record.plan_json);
  if (forgery === 'legacy') { plan.planVersion = 1; delete plan.workflow; delete plan.originalImport; }
  if (forgery === 'new-track') { plan.workflow = 'bounded-new-track'; delete plan.originalImport; }
  if (forgery === 'catalog-key') plan.originalImport.legacyKey = 'Another catalog key';
  const document = JSON.stringify(plan), checksum = hash(document);
  f.sql.prepare('UPDATE admin_publication_intent_preparations SET plan_json = ?, plan_sha256 = ?').run(document, checksum);
  assert.throws(() => f.sql.prepare(`INSERT INTO admin_publications (id, draft_id, owner_id, request_id, track_id, version_id, plan_json, plan_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(prep.id, ready.draft.id, owner.id, record.request_id,
      ready.draft.manifest.track.id, ready.draft.manifest.versionId, document, checksum), /identity or original mapping/);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
  assert.equal(f.sql.prepare('SELECT visibility FROM library_tracks').get().visibility, 'private');
});

test('proposed copy-only rollout copies a bounded review but disables both catalog publication paths', async t => {
  const { f, ready, intent, storage, copy } = await copyReady(t, { boundedReview: true });
  const config = await read('../../worker/wrangler.toml');
  const deployedFlags = Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+_ENABLED)\s*=\s*"([^"]*)"/gm)]
    .map(([, name, value]) => [name, value]));
  // Historical copy-only configuration, independent of the active final rollout.
  Object.assign(f.env, deployedFlags, { GIZMAGICK_PUBLICATION_ENABLED: 'true', GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED: 'true', GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED: 'false' });
  assert.equal(f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED, 'false');
  assert.equal(f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED, 'false');
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publishing, false);
  const html = await (await f.request('/admin')).text();
  assert(html.includes('id="intent-copy"')); assert(html.includes('id="intent-copy-confirm"'));
  assert(html.includes('Catalog publication is disabled; copying does not list the track'));
  assert(!html.includes('Nothing here publishes or changes the live player.'));
  for (const id of ['publication-panel', 'final-panel']) assert(!html.includes(`id="${id}"`));
  for (let ordinal = 0; ordinal < intent.totalObjects; ordinal++) {
    assert.equal((await copy(ordinal)).status, 200);
    // Replaying an exact completed ordinal must not copy the following object.
    assert.equal((await copy(ordinal)).status, 200);
    assert.equal(storage.objects.size, ordinal + 1);
  }
  const status = await (await intentRequest(f, ready.draft)).json();
  assert.equal(status.intent.copiedObjects, 2); assert.equal(status.publicCopyEnabled, true);
  assert.equal(status.catalogCommitEnabled, false); assert.equal(status.intent.nextAction, null);
  assert.equal((await startPublication(f, ready)).status, 503);
  assert.equal((await publicationStep(f, ready, intent.id)).status, 503);
  for (const body of [finalStart(intent), finalCommit(intent, { id: crypto.randomUUID() })]) {
    assert.equal((await finalRequest(f, ready.draft, body)).status, 503);
  }
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 2);
  for (const table of ['admin_publication_commits', 'admin_publication_final_passes', 'library_tracks', 'library_track_versions']) {
    assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
});

test('bounded final publication remains independently enabled when legacy publishing is disabled', async t => {
  const { f, ready, intent, pass } = await finalReady(t, { boundedReview: true });
  f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED = 'false';
  assert.equal((await publicationStep(f, ready, intent.id)).status, 503);
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 200);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
});

test('proposed final rollout recovers saved bounded copies and publishes only after fresh checks without legacy or R2 writes', async t => {
  const { f, ready, intent, storage, copy } = await copyReady(t, { boundedReview: true });
  for (let ordinal = 0; ordinal < intent.totalObjects; ordinal++) assert.equal((await copy(ordinal)).status, 200);
  const config = await read('../../worker/wrangler.toml');
  const deployedFlags = Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+_ENABLED)\s*=\s*"([^"]*)"/gm)]
    .map(([, name, value]) => [name, value]));
  const originalReview = f.sql.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').get(ready.draft.id);
  const originalPlan = f.sql.prepare('SELECT plan_json, plan_sha256 FROM admin_publications WHERE id = ?').get(intent.id);
  const originalReceipts = f.sql.prepare('SELECT * FROM admin_publication_objects WHERE publication_id = ? ORDER BY ordinal').all(intent.id);
  let privateHeads = 0, publicHeads = 0;
  const privateHead = f.env.GIZMAGICK_DRAFTS.head, publicHead = storage.bucket.head;
  f.env.GIZMAGICK_DRAFTS.head = key => { privateHeads++; return privateHead(key); };
  storage.bucket.head = key => { publicHeads++; return publicHead(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = storage.bucket.get = storage.bucket.put = () => assert.fail('Final rollout must not read audio bytes or write R2');

  // Historical closed-write recovery and final-enabled behavior in isolated storage.
  Object.assign(f.env, deployedFlags);
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false'; // Closed-write recovery fixture.
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED']) {
    assert.equal(f.env[flag], 'false');
  }
  assert.equal((await (await intentRequest(f, ready.draft)).json()).intent.copiedObjects, 2);
  assert.equal((await finalRequest(f, ready.draft, finalStart(intent))).status, 503);
  assert.equal(privateHeads + publicHeads, 0);

  Object.assign(f.env, { GIZMAGICK_PUBLICATION_ENABLED: 'true', GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED: 'true', GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED: 'true' });
  assert.equal(f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED, 'false');
  const html = await (await f.request('/admin')).text();
  assert(html.includes('id="final-panel"')); assert(!html.includes('id="publication-panel"'));
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publishing, false);
  assert.equal((await startPublication(f, ready)).status, 503);
  assert.equal((await publicationStep(f, ready, intent.id)).status, 503);
  const before = await (await finalRequest(f, ready.draft)).json();
  assert.equal(before.publication.copiedObjects, 2); assert.equal(before.verification, null);
  const started = await finalRequest(f, ready.draft, finalStart(intent));
  assert.equal(started.status, 201, await started.clone().text());
  const pass = (await started.json()).verification;
  assert.equal(pass.checkedObjects, 0); assert.equal(pass.planSha256, intent.planSha256);
  assert.equal(privateHeads + publicHeads, 0);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);

  const checked = await finalRequest(f, ready.draft, finalBatch(intent, pass));
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal((await checked.json()).verification.checkedObjects, 2);
  assert.equal(privateHeads, 1); assert.equal(publicHeads, 2);
  const originalBatch = f.sql.prepare('SELECT * FROM admin_publication_final_batches WHERE pass_id = ?').get(pass.id);
  privateHeads = publicHeads = 0;
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 200);
  assert.equal((await finalRequest(f, ready.draft, undefined, { method: 'HEAD' })).status, 200);
  const refreshed = await (await finalRequest(f, ready.draft)).json();
  assert.equal(refreshed.verification.id, pass.id); assert.equal(refreshed.publication.state, 'pending');
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_publication_final_batches WHERE pass_id = ?').get(pass.id), originalBatch);
  assert.equal(privateHeads + publicHeads, 0);
  for (const confirmation of ['publicationConfirmed', 'batchWindowConfirmed']) {
    assert.equal((await finalRequest(f, ready.draft, { ...finalCommit(intent, pass), [confirmation]: false })).status, 400);
  }
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  const committed = await finalRequest(f, ready.draft, finalCommit(intent, pass));
  assert.equal(committed.status, 200, await committed.clone().text());
  const published = await committed.json();
  assert.equal(published.publication.state, 'published');
  assert.equal(published.publication.finalAudit.passId, pass.id);
  assert.equal(published.publication.finalAudit.storageCheckScope, 'bounded-batches');
  assert.equal(privateHeads + publicHeads, 0);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 1);
  assert.equal(f.sql.prepare('SELECT current_version_id FROM library_tracks WHERE id = ?').get(intent.trackId).current_version_id, intent.versionId);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').get(ready.draft.id), originalReview);
  assert.deepEqual(f.sql.prepare('SELECT plan_json, plan_sha256 FROM admin_publications WHERE id = ?').get(intent.id), originalPlan);
  assert.deepEqual(f.sql.prepare('SELECT * FROM admin_publication_objects WHERE publication_id = ? ORDER BY ordinal').all(intent.id), originalReceipts);
  assert.equal(storage.objects.size, 2);

  Object.assign(f.env, deployedFlags);
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false'; // Closed-write post-publication recovery.
  const recovered = await (await intentRequest(f, ready.draft)).json();
  assert.equal(recovered.intent.state, 'published'); assert.equal(recovered.intent.copiedObjects, 2);
  assert.equal(recovered.publicCopyEnabled, false); assert.equal(recovered.intent.nextAction, null);
  const catalog = await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env);
  assert.equal((await catalog.json()).tracks[intent.trackId].versionId, intent.versionId);
  assert.equal(privateHeads + publicHeads, 0);
});

for (const count of [129, 256]) test(`final ${count}-asset verification is bounded, independent and atomically publishes only after confirmation`, async t => {
  const { f, ready, intent, pass, storage } = await finalReady(t, { count, boundedReview: true });
  let privateHeads = 0, publicHeads = 0;
  const privateHead = f.env.GIZMAGICK_DRAFTS.head, publicHead = storage.bucket.head;
  f.env.GIZMAGICK_DRAFTS.head = key => { privateHeads++; return privateHead(key); };
  storage.bucket.head = key => { publicHeads++; return publicHead(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = storage.bucket.put = () => assert.fail('Final verification never reads audio bytes or writes R2');
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 409);
  for (let offset = 0; offset < count + 1; offset += 16) {
    privateHeads = publicHeads = 0;
    const checked = await finalRequest(f, ready.draft, finalBatch(intent, pass, offset));
    assert.equal(checked.status, 200, await checked.clone().text());
    assert(privateHeads <= 16 && publicHeads <= 16);
    assert.equal((await checked.json()).verification.checkedObjects, Math.min(offset + 16, count + 1));
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
  }
  privateHeads = publicHeads = 0;
  const published = await finalRequest(f, ready.draft, finalCommit(intent, pass));
  assert.equal(published.status, 200, await published.clone().text());
  const result = await published.json(); assert.equal(result.publication.state, 'published');
  assert.equal(result.publication.finalAudit.storageCheckScope, 'bounded-batches'); assert.equal(privateHeads + publicHeads, 0);
  const catalog = await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env);
  assert.equal((await catalog.json()).tracks[intent.trackId].versionId, intent.versionId);
  const track = f.sql.prepare('SELECT * FROM library_tracks').get(); assert.equal(track.owner_id, owner.id); assert.equal(track.legacy_key, null);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
  for (const table of ['admin_publication_final_passes', 'admin_publication_final_batches']) {
    assert.throws(() => f.sql.prepare(`DELETE FROM ${table}`).run(), /retained/);
    assert.throws(() => f.sql.prepare(`UPDATE ${table} SET ${table.endsWith('passes') ? 'expires_at' : 'checked_at'} = 0`).run(), /retained/);
  }
  await f.request(`/api/admin/drafts/${ready.draft.id}/archive`, { method: 'POST' });
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  const historical = await (await intentRequest(f, ready.draft)).json(); assert.equal(historical.intent.state, 'published'); assert(historical.intent.publishedAt);
});

test('final publication fails closed without flags or migration, and requires all copies', async t => {
  const absent = await finalReady(t, { finalMigration: false });
  absent.f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  assert.equal((await finalRequest(absent.f, absent.ready.draft)).status, 503);
  assert(!(await (await absent.f.request('/admin')).text()).includes('id="final-panel"'));
  const r = await copyReady(t); r.f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'true';
  assert.equal((await finalRequest(r.f, r.ready.draft, finalStart(r.intent))).status, 409);
  assert.equal(r.f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_final_passes').get().n, 0);
  const ready = await finalReady(t);
  for (const flag of ['GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_PUBLICATION_INTENTS_ENABLED']) {
    ready.f.env[flag] = 'false'; assert.equal((await finalRequest(ready.f, ready.ready.draft, finalCommit(ready.intent, ready.pass))).status, 503); ready.f.env[flag] = 'true';
  }
  assert((await (await ready.f.request('/admin')).text()).includes('id="final-panel"'));
});

test('final API enforces owner/admin, exact IDs, input limits, methods and separate confirmations', async t => {
  const { f, ready, intent, input, pass } = await finalReady(t);
  assert.equal((await finalRequest(f, ready.draft, input, { principal: other })).status, 404);
  assert.equal((await finalRequest(f, ready.draft, input, { principal: { ...owner, role: 'user' } })).status, 403);
  assert.equal((await finalRequest(f, ready.draft, input)).status, 200);
  assert.equal((await finalRequest(f, ready.draft, { ...input, requestId: crypto.randomUUID() })).status, 409);
  for (const body of [{ ...input, overwrite: true }, { ...finalBatch(intent, pass), offset: 1 }, { ...finalCommit(intent, pass), publicationConfirmed: false },
    { ...finalCommit(intent, pass), batchWindowConfirmed: false }, { ...input, expectedPlanSha256: ['a'.repeat(64)] }]) assert.equal((await finalRequest(f, ready.draft, body)).status, 400);
  assert.equal((await finalRequest(f, ready.draft, { ...input, expectedPlanSha256: 'a'.repeat(64) })).status, 409);
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass, 16))).status, 409);
  assert.equal((await finalRequest(f, ready.draft, '{')).status, 415);
  assert.equal((await finalRequest(f, ready.draft, 'x'.repeat(2049), { headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/publication-final?offset=0`)).status, 400);
  const method = await finalRequest(f, ready.draft, undefined, { method: 'DELETE' }); assert.equal(method.status, 405); assert.equal(method.headers.get('Allow'), 'GET, HEAD, POST');
  const head = await finalRequest(f, ready.draft, undefined, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Cache-Control'), 'private, no-store'); assert.equal(head.headers.get('Access-Control-Allow-Origin'), null);
});

for (const change of ['private-etag', 'private-sha', 'private-missing', 'public-etag', 'public-sha', 'public-marker', 'public-missing', 'review', 'allocation', 'archived', 'media-base']) test(`final checks refuse changed ${change}`, async t => {
  const { f, ready, intent, pass, storage } = await finalReady(t);
  const [privateKey, privateObject] = [...f.objects][0], [publicKey, publicObject] = [...storage.objects][0];
  if (change === 'private-etag') privateObject.etag = 'changed';
  if (change === 'private-sha') privateObject.sha256 = 'a'.repeat(64);
  if (change === 'private-missing') f.objects.delete(privateKey);
  if (change === 'public-etag') publicObject.etag = 'changed';
  if (change === 'public-sha') publicObject.sha256 = 'a'.repeat(64);
  if (change === 'public-marker') publicObject.customMetadata.gizmagickPlan = 'a'.repeat(64);
  if (change === 'public-missing') storage.objects.delete(publicKey);
  if (change === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET report_json = '{}'").run();
  if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
  if (change === 'archived') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
  if (change === 'media-base') f.env.GIZMAGICK_MEDIA_BASE_URL = 'https://other.example.com';
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_final_batches').get().n, 0);
});

test('stale or future checks and expired passes require explicit restart; old passes cannot commit', async t => {
  const { f, ready, intent, input, pass } = await finalReady(t);
  await finalRequest(f, ready.draft, finalBatch(intent, pass));
  for (const clock of ["unixepoch('now') - 301", "unixepoch('now') + 1"]) {
    f.sql.prepare(`UPDATE admin_publication_final_batches SET checked_at = ${clock}`).run();
    assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 409);
  }
  const restarted = await finalRequest(f, ready.draft, { ...input, restartPassId: pass.id });
  assert.equal(restarted.status, 201); const next = (await restarted.json()).verification; assert.notEqual(next.id, pass.id);
  assert.equal(next.checkedObjects, 0); assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 409);
  await finalRequest(f, ready.draft, finalBatch(intent, next));
  f.sql.prepare('UPDATE admin_publication_final_passes SET expires_at = 0').run();
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, next))).status, 409);
});

for (const stage of ['batch', 'commit']) for (const change of ['archive', 'allocation', 'review', 'lease', 'pass', 'freshness']) test(`final ${stage} atomic write fences ${change}`, async t => {
  const { f, ready, intent, pass } = await finalReady(t);
  if (stage === 'commit') assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 200);
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query), target = stage === 'batch' ? 'INSERT INTO admin_publication_final_batches' : 'INSERT INTO admin_publication_commits';
    if (!query.startsWith(target)) return statement;
    return { bind: (...values) => ({ run: async () => {
      if (change === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
      if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
      if (change === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET report_json = '{}'").run();
      if (change === 'lease') f.sql.prepare('UPDATE admin_publications SET lease_expires_at = 0').run();
      if (change === 'pass') f.sql.prepare('UPDATE admin_publication_final_passes SET id = ?').run(crypto.randomUUID());
      if (change === 'freshness') {
        if (stage === 'batch') f.sql.prepare('UPDATE admin_publication_final_passes SET expires_at = 0').run();
        else f.sql.prepare("UPDATE admin_publication_final_batches SET checked_at = unixepoch('now') - 301").run();
      }
      return statement.bind(...values).run();
    } }) };
  };
  const result = await finalRequest(f, ready.draft, stage === 'batch' ? finalBatch(intent, pass) : finalCommit(intent, pass));
  assert.equal(result.status, 409, await result.clone().text());
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

test('failed catalog transaction rolls back all rows; lost commit reply recovers as a locked published result', async t => {
  const { f, ready, intent, pass } = await finalReady(t);
  await finalRequest(f, ready.draft, finalBatch(intent, pass));
  f.sql.exec("CREATE TRIGGER test_final_rollback BEFORE INSERT ON library_track_versions BEGIN SELECT RAISE(ABORT, 'secret provider detail'); END;");
  const failed = await finalRequest(f, ready.draft, finalCommit(intent, pass)); assert.equal(failed.status, 503); assert(!(await failed.text()).includes('secret'));
  for (const table of ['library_tracks', 'library_track_versions', 'admin_publication_commits']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  f.sql.exec('DROP TRIGGER test_final_rollback;');
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_publication_commits')) return statement;
    return { bind: (...values) => ({ run: async () => { await statement.bind(...values).run(); throw new Error('lost commit response'); } }) };
  };
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 503);
  const status = await (await finalRequest(f, ready.draft)).json(); assert.equal(status.publication.state, 'published');
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  assert.equal((await finalRequest(f, ready.draft, finalStart(intent))).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
});

test('final batch retries do not recheck or renew timestamps and concurrent final actions do not duplicate publication', async t => {
  const { f, ready, intent, pass, storage } = await finalReady(t);
  await finalRequest(f, ready.draft, finalBatch(intent, pass));
  const timestamp = f.sql.prepare('SELECT checked_at FROM admin_publication_final_batches').get().checked_at;
  f.env.GIZMAGICK_DRAFTS.head = storage.bucket.head = () => assert.fail('Repeated batch/status/commit must not perform HEADs');
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 200);
  assert.equal(f.sql.prepare('SELECT checked_at FROM admin_publication_final_batches').get().checked_at, timestamp);
  const replies = await Promise.all([1, 2].map(() => finalRequest(f, ready.draft, finalCommit(intent, pass))));
  assert(replies.some(reply => reply.status === 200)); assert(replies.every(reply => [200, 409].includes(reply.status)));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 1);
});

test('freshness starts before batch HEADs and records the whole check interval', async t => {
  for (const age of [120, 301]) {
    const { f, ready, intent, pass } = await finalReady(t), prepare = f.env.GIZMAGICK_DB.prepare;
    f.env.GIZMAGICK_DB.prepare = query => query === "SELECT unixepoch('now') AS checkedAt"
      ? { first: async () => ({ checkedAt: f.sql.prepare("SELECT unixepoch('now') AS n").get().n - age }) } : prepare(query);
    const checked = await finalRequest(f, ready.draft, finalBatch(intent, pass));
    assert.equal(checked.status, age === 120 ? 200 : 409);
    if (age === 120) {
      const interval = (await checked.json()).verification;
      assert(interval.lastCheckedAt - interval.firstCheckedAt >= 120);
      assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
    } else assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_final_batches').get().n, 0);
  }
});

test('future final completion times and catalog identity collisions cannot pass the commit fence', async t => {
  for (const change of ['finished', 'identity']) {
    const { f, ready, intent, pass } = await finalReady(t);
    await finalRequest(f, ready.draft, finalBatch(intent, pass));
    if (change === 'finished') f.sql.prepare("UPDATE admin_publication_final_batches SET finished_at = unixepoch('now') + 60").run();
    else f.sql.prepare('INSERT INTO library_tracks (id, owner_id) VALUES (?, ?)').run(intent.trackId, other.id);
    assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 409);
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_commits').get().n, 0);
  }
});

for (const count of [129, 256]) test(`bounded copying handles ${count} files one at a time, manifest last, without catalog publication`, async t => {
  const { f, ready, intent, storage, copy } = await copyReady(t, { count, boundedReview: true });
  let privateHeads = 0, gets = 0, publicHeads = 0, puts = 0;
  const head = f.env.GIZMAGICK_DRAFTS.head, get = f.env.GIZMAGICK_DRAFTS.get;
  const publicHead = storage.bucket.head, put = storage.bucket.put;
  f.env.GIZMAGICK_DRAFTS.head = key => { privateHeads++; return head(key); };
  f.env.GIZMAGICK_DRAFTS.get = (key, opts) => { gets++; assert(opts.onlyIf.etagMatches); return get(key, opts); };
  storage.bucket.head = key => { publicHeads++; return publicHead(key); };
  storage.bucket.put = (key, bytes, opts) => { puts++; return put(key, bytes, opts); };
  const plan = JSON.parse(f.sql.prepare('SELECT plan_json FROM admin_publications').get().plan_json);
  for (let ordinal = 0; ordinal < count + 1; ordinal++) {
    privateHeads = gets = publicHeads = puts = 0;
    const result = await copy(ordinal);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).intent.copiedObjects, ordinal + 1);
    // The fake GET and PUT also call HEAD internally; actual binding methods
    // are independently bounded, not proportional to track size.
    assert(privateHeads <= 2 && gets <= 1 && publicHeads <= 3 && puts === 1);
    assert.equal(storage.objects.size, ordinal + 1);
    assert(storage.objects.has(plan.objects[ordinal].key));
    if (ordinal < count) assert(!storage.objects.has(plan.objects.at(-1).key));
  }
  const status = await (await intentRequest(f, ready.draft)).json();
  assert.equal(status.intent.nextAction, null); assert.equal(status.intent.continuationBlocked, true);
  assert.equal(status.catalogCommitEnabled, false); assert.equal(status.publishing, false);
  for (const object of plan.objects) assert.equal(hash(storage.objects.get(object.key).bytes), object.sha256);
  for (const table of ['admin_publication_commits', 'library_tracks', 'library_track_versions']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.throws(() => f.sql.prepare('INSERT INTO admin_publication_commits (publication_id, lease_token) VALUES (?, ?)').run(intent.id, 'forged'), /Bounded final verification|Publication changed before commit/);
});

test('bounded copying requires all rollout gates and migration 0008 before any public write', async t => {
  const { f, ready, copy, storage } = await copyReady(t, { copyMigration: false });
  assert.equal((await copy()).status, 503); assert.equal(storage.objects.size, 0);
  f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = 'false';
  assert.equal((await intentRequest(f, ready.draft)).status, 200); assert.equal((await copy()).status, 503);
  assert(!(await (await f.request('/admin')).text()).includes('id="intent-copy"'));
  const enabled = await copyReady(t);
  for (const flag of ['GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_PUBLICATION_INTENTS_ENABLED', 'GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED']) {
    enabled.f.env[flag] = 'false'; assert.equal((await enabled.copy()).status, 503); enabled.f.env[flag] = 'true';
  }
  assert.equal(enabled.storage.objects.size, 0);
  assert((await (await enabled.f.request('/admin')).text()).includes('id="intent-copy"'));
});

test('copy requests pin intent, checksum, ordinal, ownership and fresh confirmation; reads never copy', async t => {
  const { f, ready, intent, body, copy, storage } = await copyReady(t);
  assert.equal((await copy(0, { principal: other })).status, 404);
  assert.equal((await copy(0, { principal: { ...owner, role: 'user' } })).status, 403);
  for (const change of [{ ordinal: -1 }, { ordinal: 257 }, { ordinal: 0.1 }, { publicationConfirmed: false }, { expectedPlanSha256: ['a'.repeat(64)] }, { overwrite: true }]) {
    assert.equal((await intentRequest(f, ready.draft, { ...body(0), ...change })).status, 400);
  }
  assert.equal((await intentRequest(f, ready.draft, { ...body(0), publicationId: crypto.randomUUID() })).status, 404);
  assert.equal((await intentRequest(f, ready.draft, { ...body(0), expectedPlanSha256: 'a'.repeat(64) })).status, 409);
  assert.equal((await copy(1)).status, 409);
  for (const method of ['GET', 'HEAD']) assert.equal((await intentRequest(f, ready.draft, undefined, { method })).status, 200);
  assert.equal(storage.objects.size, 0);
  assert.equal((await copy()).status, 200);
  assert.equal((await copy()).status, 200); // Same ordinal never copies manifest.
  assert.equal(storage.objects.size, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects WHERE publication_id = ?').get(intent.id).n, 1);
});

for (const change of ['etag', 'sha', 'missing', 'allocation', 'review', 'archived', 'media-base', 'identity']) test(`bounded copy rejects changed ${change} before public exposure`, async t => {
  const { f, intent, copy, storage } = await copyReady(t);
  const [key, object] = [...f.objects][0];
  if (change === 'etag') object.etag = 'changed';
  if (change === 'sha') object.sha256 = 'a'.repeat(64);
  if (change === 'missing') f.objects.delete(key);
  if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
  if (change === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET candidate_json = '{}'").run();
  if (change === 'archived') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
  if (change === 'media-base') f.env.GIZMAGICK_MEDIA_BASE_URL = 'https://other.example.com';
  if (change === 'identity') f.sql.prepare('INSERT INTO library_tracks (id, owner_id) VALUES (?, ?)').run(intent.trackId, owner.id);
  assert.equal((await copy()).status, 409); assert.equal(storage.objects.size, 0);
});

test('conditional private GET closes the HEAD/read race and supplied checksum rejects changed streamed bytes', async t => {
  for (const change of ['etag', 'stream']) {
    const { f, copy, storage } = await copyReady(t), get = f.env.GIZMAGICK_DRAFTS.get;
    f.env.GIZMAGICK_DRAFTS.get = async (key, options) => {
      if (change === 'etag') f.objects.get(key).etag = 'replaced';
      const result = await get(key, options);
      if (change === 'stream') result.body = new Response(ogg(2)).body;
      return result;
    };
    assert.equal((await copy()).status, change === 'etag' ? 409 : 503);
    assert.equal(storage.objects.size, 0);
  }
});

test('conditional public PUT cannot overwrite a destination created after its HEAD', async t => {
  const { copy, storage } = await copyReady(t);
  storage.hooks.beforePut = key => storage.objects.set(key, { bytes: ogg(), sha256: hash(ogg()), etag: 'unrelated', customMetadata: {}, httpMetadata: {} });
  assert.equal((await copy()).status, 409);
  assert.equal([...storage.objects.values()][0].etag, 'unrelated');
});

test('lost PUT or receipt responses recover only exact intent-marked bytes without another PUT', async t => {
  const { f, ready, copy, storage } = await copyReady(t);
  storage.hooks.afterPut = () => { throw new Error('lost response containing secret credentials'); };
  const failed = await copy(); assert.equal(failed.status, 503); assert(!(await failed.text()).includes('credentials'));
  assert.equal(storage.objects.size, 1);
  assert.equal((await (await intentRequest(f, ready.draft)).json()).intent.copiedObjects, 0);
  delete storage.hooks.afterPut; storage.hooks.beforePut = () => assert.fail('Must not overwrite recovery object');
  const object = [...storage.objects.values()][0], markers = { ...object.customMetadata };
  object.customMetadata.gizmagickPublication = crypto.randomUUID(); assert.equal((await copy()).status, 409);
  object.customMetadata = markers;
  assert.equal((await copy()).status, 200); assert.equal((await copy()).status, 200);
  assert.equal(storage.objects.size, 1);
});

for (const stage of ['before-put', 'before-receipt']) for (const change of ['archive', 'allocation', 'review', 'lease']) test(`bounded copy fences ${change} ${stage}`, async t => {
  const { f, copy, storage } = await copyReady(t);
  const mutate = () => {
    if (change === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
    if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
    if (change === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET report_json = '{}'").run();
    if (change === 'lease') f.sql.prepare('UPDATE admin_publications SET lease_expires_at = 0').run();
  };
  if (stage === 'before-put') {
    const get = f.env.GIZMAGICK_DRAFTS.get;
    f.env.GIZMAGICK_DRAFTS.get = async (...args) => { const object = await get(...args); mutate(); return object; };
  } else {
    const prepare = f.env.GIZMAGICK_DB.prepare;
    f.env.GIZMAGICK_DB.prepare = query => {
      const statement = prepare(query);
      if (!query.startsWith('INSERT INTO admin_publication_objects')) return statement;
      return { bind: (...values) => ({ run: async () => { mutate(); return statement.bind(...values).run(); } }) };
    };
  }
  assert.equal((await copy()).status, 409);
  assert.equal(storage.objects.size, stage === 'before-put' ? 0 : 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

test('parallel copies do not overlap and a lost receipt reply is acknowledged without copying next object', async t => {
  const { f, copy, storage } = await copyReady(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const get = f.env.GIZMAGICK_DRAFTS.get;
  f.env.GIZMAGICK_DRAFTS.get = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return get(...args); };
  const first = copy(); await started;
  assert.equal((await copy()).status, 409); release(); assert.equal((await first).status, 200);
  f.env.GIZMAGICK_DRAFTS.get = get;
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_publication_objects')) return statement;
    return { bind: (...values) => ({ run: async () => { await statement.bind(...values).run(); throw new Error('lost receipt reply'); } }) };
  };
  assert.equal((await copy(1)).status, 503);
  assert.equal((await copy(1)).status, 200); assert.equal(storage.objects.size, 2);
});

test('copying can be disabled after exposure without hiding progress or pretending public files are private', async t => {
  const { f, ready, copy, storage } = await copyReady(t);
  assert.equal((await copy()).status, 200);
  f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = 'false';
  const status = await (await intentRequest(f, ready.draft)).json();
  assert.equal(status.intent.copiedObjects, 1); assert.equal(status.publicCopyEnabled, false);
  assert.equal(status.intent.nextAction, null); assert.equal(status.intent.continuationBlocked, true);
  assert.equal((await copy(1)).status, 503); assert.equal(storage.objects.size, 1);
});

for (const corruption of ['native-sha', 'custom-sha', 'size', 'plan-marker', 'content-type', 'cache']) test(`unrecorded public recovery rejects mismatched ${corruption}`, async t => {
  const { copy, storage } = await copyReady(t);
  storage.hooks.afterPut = () => { throw new Error('lost response'); };
  assert.equal((await copy()).status, 503); delete storage.hooks.afterPut;
  const object = [...storage.objects.values()][0];
  if (corruption === 'native-sha') object.sha256 = 'a'.repeat(64);
  if (corruption === 'custom-sha') object.customMetadata.sha256 = 'a'.repeat(64);
  if (corruption === 'size') object.bytes = ogg().slice(0, 10);
  if (corruption === 'plan-marker') object.customMetadata.gizmagickPlan = 'a'.repeat(64);
  if (corruption === 'content-type') object.httpMetadata.contentType = 'text/plain';
  if (corruption === 'cache') object.httpMetadata.cacheControl = 'no-cache';
  storage.hooks.beforePut = () => assert.fail('Recovery cannot overwrite');
  assert.equal((await copy()).status, 409); assert.equal(storage.objects.size, 1);
});

test('an expired lease after PUT prevents its receipt; exact recovery needs a new lease', async t => {
  const { f, copy, storage } = await copyReady(t);
  storage.hooks.afterPut = () => f.sql.prepare('UPDATE admin_publications SET lease_expires_at = 0').run();
  assert.equal((await copy()).status, 409); assert.equal(storage.objects.size, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
  delete storage.hooks.afterPut; assert.equal((await copy()).status, 200);
});

test('bounded copy cannot adopt a legacy intent and version-1 copies still work without migration 0008', async t => {
  const f = fixture(t, { copyMigration: false }), ready = await readyReview(f); await ready.attest();
  enablePublisher(f);
  const started = await startPublication(f, ready), intent = (await started.json()).publication;
  assert.equal((await publicationStep(f, ready, intent.id)).status, 200);
  f.sql.exec(migrations[7]); f.env.GIZMAGICK_PUBLICATION_INTENTS_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = 'true';
  const planHash = f.sql.prepare('SELECT plan_sha256 FROM admin_publications WHERE id = ?').get(intent.id).plan_sha256;
  assert.equal((await intentRequest(f, ready.draft, { action: 'copy-one', publicationId: intent.id, expectedPlanSha256: planHash,
    ordinal: 1, publicationConfirmed: true })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 1);
});

test('disabled intent workflow needs no migration 0007 and never queries its tables', async t => {
  const f = fixture(t, { intentMigration: false }), ready = await readyReview(f); await ready.attest(); enablePublicationPreview(f);
  assert.equal((await intentRequest(f, ready.draft)).status, 503);
  assert.equal((await intentRequest(f, ready.draft, intentInput(ready))).status, 503);
  assert(!(await (await f.request('/admin')).text()).includes('id="intent-panel"'));
  assert.equal((await publicationPreview(f, ready.draft)).status, 200);
});

test('intent routes enforce admin/ownership, strict inputs, methods, exact request IDs and final confirmation', async t => {
  const f = fixture(t), ready = await preparedIntent(f), { draft, input, preparation } = ready;
  assert.equal((await intentRequest(f, draft, input, { principal: other })).status, 404);
  assert.equal((await intentRequest(f, draft, input, { principal: { ...owner, role: 'user' } })).status, 403);
  assert.equal((await intentRequest(f, draft, input)).status, 200);
  assert.equal((await intentRequest(f, draft, { ...input, requestId: crypto.randomUUID() })).status, 409);
  for (const body of [{ ...input, candidate: {} }, { action: 'copy' }, { action: 'check-batch', preparationId: preparation.id, offset: 1 }, { ...reserveInput(preparation), batchWindowConfirmed: false }]) assert.equal((await intentRequest(f, draft, body)).status, 400);
  assert.equal((await intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 16 })).status, 409);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/publication-intent?offset=0`)).status, 400);
  const unsupported = await intentRequest(f, draft, undefined, { method: 'DELETE' }); assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.get('Allow'), 'GET, HEAD, POST');
  const head = await intentRequest(f, draft, undefined, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Cache-Control'), 'private, no-store'); assert.equal(head.headers.get('Access-Control-Allow-Origin'), null);
});

for (const change of ['private-etag', 'private-checksum', 'missing', 'destination', 'review', 'allocation', 'media-base', 'archived', 'expired']) test(`intent readiness rejects ${change}`, async t => {
  const f = fixture(t), ready = await preparedIntent(f), { draft, preparation } = ready;
  const [key, object] = [...f.objects][0];
  if (change === 'private-etag') object.etag = 'changed';
  if (change === 'private-checksum') object.sha256 = 'c'.repeat(64);
  if (change === 'missing') f.objects.delete(key);
  if (change === 'destination') f.env.GIZMAGICK_MEDIA.head = async () => ({ size: 47, etag: 'unrelated' });
  if (change === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET candidate_json = '{}'").run();
  if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
  if (change === 'media-base') f.env.GIZMAGICK_MEDIA_BASE_URL = 'https://other.example/media';
  if (change === 'archived') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
  if (change === 'expired') f.sql.prepare('UPDATE admin_publication_intent_preparations SET expires_at = 0').run();
  assert.equal((await intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 0 })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_intent_batches').get().n, 0);
});

for (const change of ['archive', 'allocation', 'review', 'freshness', 'replacement']) test(`intent reservation fences a ${change} race at its atomic insert`, async t => {
  const f = fixture(t), ready = await preparedIntent(f), { draft, preparation } = ready;
  await intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 0 });
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_publications')) return statement;
    return { bind: (...values) => ({ run: async () => {
      if (change === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
      if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
      if (change === 'review') f.sql.prepare("UPDATE admin_draft_reviews SET report_json = '{}'").run();
      if (change === 'freshness') f.sql.prepare("UPDATE admin_publication_intent_batches SET checked_at = unixepoch('now') - 301").run();
      if (change === 'replacement') await intentRequest(f, draft, { ...ready.input, restartPreparationId: preparation.id });
      return statement.bind(...values).run();
    } }) };
  };
  assert.equal((await intentRequest(f, draft, reserveInput(preparation))).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

test('stale checks restart only explicitly; reserved intent and legacy intent cannot be replaced', async t => {
  const f = fixture(t), ready = await preparedIntent(f), { draft, preparation } = ready;
  await intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 0 });
  f.sql.prepare("UPDATE admin_publication_intent_batches SET checked_at = unixepoch('now') - 301").run();
  assert.equal((await (await intentRequest(f, draft)).json()).preparation.recent, false);
  assert.equal((await intentRequest(f, draft, reserveInput(preparation))).status, 409);
  const restarted = (await (await intentRequest(f, draft, ready.input)).json()).preparation;
  assert.notEqual(restarted.id, preparation.id); assert.equal(restarted.checkedObjects, 0);
  await intentRequest(f, draft, { action: 'check-batch', preparationId: restarted.id, offset: 0 });
  assert.equal((await intentRequest(f, draft, reserveInput(restarted))).status, 201);
  assert.equal((await intentRequest(f, draft, { ...ready.input, restartPreparationId: restarted.id })).status, 409);
  const legacy = await startedPublisher(t); enableIntents(legacy.f);
  assert.equal((await (await intentRequest(legacy.f, legacy.ready.draft)).json()).legacyPublication.id, legacy.publication.id);
  assert.equal((await intentRequest(legacy.f, legacy.ready.draft, intentInput(legacy.ready))).status, 409);
});

test('concurrent intent batches and reservations converge without public writes or duplicate identity', async t => {
  const f = fixture(t), ready = await preparedIntent(f), { draft, preparation } = ready;
  const batches = await Promise.all([0, 1].map(() => intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 0 })));
  assert(batches.every(response => response.status === 200));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_intent_batches').get().n, 1);
  const reserved = await Promise.all([0, 1].map(() => intentRequest(f, draft, reserveInput(preparation))));
  assert(reserved.every(response => [200, 201].includes(response.status)));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publication_objects').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 0);
});

test('future-dated readiness receipts cannot reserve an intent and storage errors are sanitized', async t => {
  const f = fixture(t), ready = await preparedIntent(f), { draft, preparation } = ready;
  const head = f.env.GIZMAGICK_MEDIA.head;
  f.env.GIZMAGICK_MEDIA.head = () => { throw new Error('secret credentials in provider failure'); };
  const error = await intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 0 });
  assert.equal(error.status, 503); assert(!(await error.text()).includes('credentials'));
  f.env.GIZMAGICK_MEDIA.head = head;
  await intentRequest(f, draft, { action: 'check-batch', preparationId: preparation.id, offset: 0 });
  f.sql.prepare("UPDATE admin_publication_intent_batches SET checked_at = unixepoch('now') + 300").run();
  assert.equal((await intentRequest(f, draft, reserveInput(preparation))).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

for (const count of [129, 256]) test(`${count}-file batched attestation uses fresh independent rechecks and a separate immutable human audit`, async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = f.env.GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED = 'true';
  const input = count === 129 ? { requestId: crypto.randomUUID(), manifest: JSON.parse(await read('../public/tracks/Testing Time/manifest.json')) } : canonical();
  if (count === 129) for (const asset of Object.values(input.manifest.assets)) { delete asset.byteLength; delete asset.sha256; }
  if (count === 256) for (let i = 1; i < count; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/extra-${i}.ogg` };
  const draft = await uploadedDraft(f, input), prep = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  for (let offset = 0; offset < count; offset += 16) await packageRequest(f, draft, 'batch', { jobId: prep.jobId, offset });
  const job = (await (await packageRequest(f, draft, 'finish', { jobId: prep.jobId })).json()).package, report = await syntheticReport(job);
  assert.equal((await (await verifyRequest(f, draft)).json()).verification, null);
  const started = await verifyRequest(f, draft, undefined, verifyBegin(report));
  assert.equal(started.status, 200, await started.clone().text());
  const attempt = (await started.json()).verification;
  assert.equal(attempt.checkedAssets, 0); // Preparation batches cannot count as approval checks.
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(attempt.id))).status, 409);
  let heads = 0, databaseCalls = 0; const head = f.env.GIZMAGICK_DRAFTS.head, prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => { databaseCalls++; return prepare(query); };
  f.env.GIZMAGICK_DRAFTS.head = key => { heads++; return head(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = () => assert.fail('Rechecking must not decode or write audio');
  f.env.GIZMAGICK_MEDIA.head = () => assert.fail('Private review must not inspect public storage');
  for (let offset = 0; offset < count; offset += 16) {
    heads = 0; databaseCalls = 0;
    const response = await verifyRequest(f, draft, 'review-verification-batch', { verificationId: attempt.id, offset });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(heads, Math.min(16, count - offset));
    assert(heads + databaseCalls < 50, `Conservative fixture-operation budget exceeded: ${heads + databaseCalls}`);
    assert.equal((await response.json()).verification.checkedAssets, Math.min(offset + 16, count));
    heads = 0;
    assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: attempt.id, offset })).status, 200);
    assert.equal((await (await verifyRequest(f, draft)).json()).verification.checkedAssets, Math.min(offset + 16, count));
    assert.equal(heads, 0); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
  }
  const confirmed = await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(attempt.id));
  assert.equal(confirmed.status, 201, await confirmed.clone().text());
  const result = await confirmed.json();
  assert.equal(heads, 0); assert.equal(result.review.storageCheckScope, 'bounded-batches');
  assert.equal(result.review.storageVerificationId, attempt.id); assert.equal(result.review.serverDecoded, false);
  assert.equal(result.pointInTimeBatches, true); assert.equal(result.publicationAuthorized, false);
  assert.equal(result.verification.state, 'attested');
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(attempt.id))).status, 200);
  assert.equal((await (await verifyRequest(f, draft)).json()).review.reportSha256, result.review.reportSha256);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
  assert.throws(() => f.sql.prepare("UPDATE admin_draft_reviews SET storage_check_scope = 'single-request'").run(), /immutable/);
  assert.throws(() => f.sql.prepare('DELETE FROM admin_draft_reviews').run(), /retained/);
  assert.throws(() => f.sql.prepare('UPDATE admin_draft_review_verifications SET expires_at = 0').run(), /retained/);
  assert.throws(() => f.sql.prepare('DELETE FROM admin_draft_review_verification_batches').run(), /retained/);
});

test('disabled batched verification needs no new tables and leaves legacy review unchanged', async t => {
  const f = fixture(t, { verificationMigration: false }), ready = await readyReview(f);
  for (const operation of ['review-verification', 'review-verification-batch', 'attest-review-batched']) assert.equal((await verifyRequest(f, ready.draft, operation, {})).status, 503);
  assert(!(await (await f.request('/admin')).text()).includes('id="verification-panel"'));
  assert.equal((await ready.attest()).status, 201);
});

async function startedVerification(f, input = canonical()) {
  f.env.GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED = 'true';
  const ready = await readyReview(f, input), response = await verifyRequest(f, ready.draft, undefined, verifyBegin(ready.report));
  assert.equal(response.status, 200, await response.clone().text());
  return { ...ready, verification: (await response.json()).verification };
}

test('verification requires exact report/provenance, admin ownership, method guards and a fresh final window confirmation', async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  assert.equal((await verifyRequest(f, draft, undefined, verifyBegin(ready.report), { principal: other })).status, 404);
  assert.equal((await verifyRequest(f, draft, undefined, verifyBegin(ready.report), { principal: { ...owner, role: 'user' } })).status, 403);
  for (const body of [{ ...verifyBegin(ready.report), provenanceConfirmed: false }, { ...verifyBegin(ready.report), serverDecoded: true }]) assert.equal((await verifyRequest(f, draft, undefined, body)).status, 400);
  const broken = structuredClone(ready.report); broken.measurements[Object.keys(broken.measurements)[0]].sampleCount = 1;
  assert.equal((await verifyRequest(f, draft, undefined, verifyBegin(broken))).status, 422);
  assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 16 })).status, 409);
  assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 1 })).status, 400);
  assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0, assets: [] })).status, 400);
  assert.equal((await verifyRequest(f, draft, 'review-verification-batch')).status, 405);
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', { ...verifyFinish(verification.id), batchWindowConfirmed: false })).status, 400);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/review-verification?offset=0`)).status, 400);
  await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 });
  const head = await verifyRequest(f, draft, 'review-verification', undefined, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Cache-Control'), 'private, no-store'); assert.equal(head.headers.get('Access-Control-Allow-Origin'), null);
});

for (const change of ['etag', 'missing', 'sha', 'metadata', 'allocation', 'package', 'report', 'expired']) test(`batched verification rejects ${change}`, async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  const [key, object] = [...f.objects][0];
  if (change === 'etag') object.etag = 'changed';
  if (change === 'missing') f.objects.delete(key);
  if (change === 'sha') object.sha256 = 'b'.repeat(64);
  if (change === 'metadata') { draft.manifest.track.title = 'Changed'; f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(draft.manifest), draft.id); }
  if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
  if (change === 'package') f.sql.prepare('UPDATE admin_draft_review_jobs SET id = ?').run(crypto.randomUUID());
  if (change === 'report') f.sql.prepare("UPDATE admin_draft_review_verifications SET report_json = '{}'").run();
  if (change === 'expired') f.sql.prepare('UPDATE admin_draft_review_verifications SET expires_at = 0').run();
  const response = await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_verification_batches').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('recent-check window prevents using old receipts; only explicit restart clears them', async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 });
  f.sql.prepare("UPDATE admin_draft_review_verification_batches SET checked_at = unixepoch('now') - 301").run();
  assert.equal((await verifyRequest(f, draft)).status, 409);
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id))).status, 409);
  const next = await (await verifyRequest(f, draft, undefined, verifyBegin(ready.report))).json();
  assert.notEqual(next.verification.id, verification.id); assert.equal(next.verification.checkedAssets, 0);
  assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 })).status, 409);
});

test('future-dated receipts cannot satisfy the freshness window', async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 });
  f.sql.prepare("UPDATE admin_draft_review_verification_batches SET checked_at = unixepoch('now') + 3600").run();
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id))).status, 409);
  assert.notEqual((await (await verifyRequest(f, draft, undefined, verifyBegin(ready.report))).json()).verification.id, verification.id);
});

test('concurrent rechecks/final confirmations converge on one receipt and audit; completed retries only acknowledge history', async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  const batches = await Promise.all([0, 1].map(() => verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 })));
  assert(batches.every(response => response.status === 200));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_verification_batches').get().n, 1);
  const finishes = await Promise.all([0, 1].map(() => verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id))));
  assert(finishes.every(response => [200, 201].includes(response.status)));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 1);
  await f.request(`/api/admin/drafts/${draft.id}/archive`, { method: 'POST' });
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id))).status, 200);
  assert.equal((await verifyRequest(f, draft, undefined, verifyBegin(ready.report))).status, 409);
});

for (const race of ['archive', 'ownership', 'package', 'expiry']) test(`verification receipt rejects a ${race} change during storage checks`, async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready, head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = async key => {
    const object = await head(key);
    if (race === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
    if (race === 'ownership') f.sql.prepare('UPDATE admin_drafts SET owner_id = ?').run(other.id);
    if (race === 'package') f.sql.prepare('UPDATE admin_draft_review_jobs SET id = ?').run(crypto.randomUUID());
    if (race === 'expiry') f.sql.prepare('UPDATE admin_draft_review_verifications SET expires_at = 0').run();
    return object;
  };
  assert.equal((await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_verification_batches').get().n, 0);
});

for (const race of ['archive', 'allocation', 'replacement', 'expiry']) test(`atomic batched attestation rejects a ${race} race`, async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 });
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_draft_reviews')) return statement;
    return { bind: (...values) => ({ run: async () => {
      if (race === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived'").run();
      if (race === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending'").run();
      if (race === 'replacement') await verifyRequest(f, draft, undefined, { ...verifyBegin(ready.report), restartVerificationId: verification.id });
      if (race === 'expiry') f.sql.prepare("UPDATE admin_draft_review_verification_batches SET checked_at = unixepoch('now') - 301").run();
      return statement.bind(...values).run();
    } }) };
  };
  assert.equal((await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id))).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('batched reviews are labeled point-in-time and cannot enter the current publisher', async t => {
  const f = fixture(t), ready = await startedVerification(f), { draft, verification } = ready;
  await verifyRequest(f, draft, 'review-verification-batch', { verificationId: verification.id, offset: 0 });
  // Earlier objects are not checked again at final confirmation. Never claim atomicity.
  [...f.objects.values()][0].etag = 'externally-changed-after-batch';
  const response = await verifyRequest(f, draft, 'attest-review-batched', verifyFinish(verification.id));
  assert.equal(response.status, 201); assert.equal((await response.json()).pointInTimeBatches, true);
  enablePublisher(f);
  const preview = await publicationPreview(f, draft); assert.equal(preview.status, 409);
  assert.equal((await preview.json()).code, 'PUBLICATION_PREFLIGHT_BATCH_REVIEW');
  assert.equal((await startPublication(f, ready)).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

for (const count of [129, 256]) test(`durable ${count}-file review packaging resumes bounded batches and produces a canonical package without approval`, async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const input = count === 129 ? { requestId: crypto.randomUUID(), manifest: JSON.parse(await read('../public/tracks/Testing Time/manifest.json')) } : canonical();
  if (count === 129) for (const asset of Object.values(input.manifest.assets)) { delete asset.byteLength; delete asset.sha256; }
  if (count === 256) for (let i = 1; i < count; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/extra-${i}.ogg` };
  const draft = await uploadedDraft(f, input);
  assert.equal((await (await packageRequest(f, draft)).json()).preparation, null);
  const started = await packageRequest(f, draft, 'batches', {});
  assert.equal(started.status, 201, await started.clone().text());
  const job = (await started.json()).preparation;
  assert.equal(job.checkedAssets, 0); assert.equal(job.ready, false);
  assert.equal((await (await packageRequest(f, draft, 'batches', {})).json()).preparation.jobId, job.jobId);
  const head = f.env.GIZMAGICK_DRAFTS.head; let heads = 0;
  f.env.GIZMAGICK_DRAFTS.head = key => { heads++; return head(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = () => assert.fail('Package preparation cannot read audio bytes or write R2');
  f.env.GIZMAGICK_MEDIA.head = () => assert.fail('Package preparation cannot touch public storage');
  assert.equal((await packageRequest(f, draft, 'finish', { jobId: job.jobId })).status, 409);
  for (let offset = 0; offset < count; offset += 16) {
    heads = 0;
    const response = await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(heads, Math.min(16, count - offset));
    const result = await response.json(); assert.equal(result.preparation.checkedAssets, Math.min(offset + 16, count));
    assert.equal(result.preparation.ready, false); assert.equal(result.audioProbed, false); assert.equal(result.publicationAuthorized, false);
    heads = 0;
    const status = await packageRequest(f, draft);
    assert.equal(status.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await status.json()).preparation.checkedAssets, Math.min(offset + 16, count));
    // Lost-response retry returns the durable receipt without inspecting again.
    assert.equal((await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset })).status, 200); assert.equal(heads, 0);
  }
  const finish = await packageRequest(f, draft, 'finish', { jobId: job.jobId });
  assert.equal(finish.status, 200, await finish.clone().text());
  const completed = await finish.json(); assert.equal(completed.preparation.ready, true); assert.equal(heads, 0);
  assert.equal(completed.package.packageVersion, 1); assert.equal(completed.package.policy, REVIEW_POLICY);
  assert.equal(completed.package.jobId, job.jobId); assert.equal(completed.package.snapshot.assets.length, count);
  assert.equal(completed.package.snapshot.draftId, draft.id);
  assert.equal(completed.package.snapshotSha256, hash(Buffer.from(JSON.stringify(completed.package.snapshot))));
  const writes = f.sql.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual((await (await packageRequest(f, draft, 'finish', { jobId: job.jobId })).json()).package, completed.package);
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n, writes);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_package_batches').get().n, Math.ceil(count / 16));
  for (const table of ['admin_draft_reviews', 'admin_publications', 'library_tracks']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('batch packaging is disabled without migration 0005 and exposes controls only when enabled', async t => {
  const f = fixture(t), draft = await uploadedDraft(f);
  f.sql.exec('DROP TRIGGER admin_package_replace_batches; DROP TABLE admin_draft_package_batches; DROP TABLE admin_draft_package_preparations;');
  for (const operation of ['batches', 'batch', 'finish']) assert.equal((await packageRequest(f, draft, operation, {})).status, 503);
  assert(!(await (await f.request('/admin')).text()).includes('id="package-panel"'));
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.batchPackages, false);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/review-package`, { method: 'POST' })).status, 200);
});

test('batch packages preserve method, owner, input and order gates', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f);
  assert((await (await f.request('/admin')).text()).includes('id="package-panel"'));
  assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.batchPackages, true);
  assert.equal((await packageRequest(f, draft, 'batches', {}, { principal: other })).status, 404);
  assert.equal((await packageRequest(f, draft, 'batches', {}, { principal: { ...owner, role: 'user' } })).status, 403);
  for (const operation of ['batch', 'finish']) {
    const rejected = await packageRequest(f, draft, operation);
    assert.equal(rejected.status, 405); assert.equal(rejected.headers.get('Allow'), 'POST');
  }
  assert.equal((await packageRequest(f, draft, 'batches', {}, { method: 'DELETE' })).status, 405);
  for (const body of [{ assets: [] }, { snapshot: {} }, { restartJobId: 'bad' }, []]) assert.equal((await packageRequest(f, draft, 'batches', body)).status, 400);
  const job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  for (const body of [{ jobId: job.jobId, offset: -1 }, { jobId: job.jobId, offset: 1 }, { jobId: job.jobId, offset: 0, assets: [] }, { jobId: 'bad', offset: 0 }]) {
    assert.equal((await packageRequest(f, draft, 'batch', body)).status, 400);
  }
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: crypto.randomUUID(), offset: 0 })).status, 409);
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 16 })).status, 409);
  assert.equal((await f.request(`/api/admin/drafts/${draft.id}/review-package-batches?offset=0`)).status, 400);
  assert.equal((await packageRequest(f, draft, 'batches', 'x'.repeat(2049))).status, 415);
  assert.equal((await packageRequest(f, draft, 'batches', 'x'.repeat(2049), { headers: { 'Content-Type': 'application/json' } })).status, 413);
  const statusHead = await packageRequest(f, draft, 'batches', undefined, { method: 'HEAD' });
  assert.equal(statusHead.status, 200); assert.equal(await statusHead.text(), '');
});

test('restarting or expiring preparation replaces batches and invalidates its completed package', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 });
  await packageRequest(f, draft, 'finish', { jobId: job.jobId });
  assert.equal((await packageRequest(f, draft, 'batches', { restartJobId: crypto.randomUUID() })).status, 409);
  const restarted = await packageRequest(f, draft, 'batches', { restartJobId: job.jobId });
  assert.equal(restarted.status, 201, await restarted.clone().text());
  const next = (await restarted.json()).preparation;
  assert.notEqual(next.jobId, job.jobId); assert.equal(next.checkedAssets, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_package_batches').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_jobs').get().n, 0);
  assert.equal((await packageRequest(f, draft, 'finish', { jobId: job.jobId })).status, 409);
  f.sql.prepare('UPDATE admin_draft_package_preparations SET expires_at = 0 WHERE draft_id = ?').run(draft.id);
  assert.equal((await packageRequest(f, draft)).status, 409);
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: next.jobId, offset: 0 })).status, 409);
  assert.notEqual((await (await packageRequest(f, draft, 'batches', {})).json()).preparation.jobId, next.jobId);
});

test('package preparation refuses stale metadata and renews only on deliberate start', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  const changed = structuredClone(draft.manifest); changed.track.title = 'Changed';
  f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(changed), draft.id);
  assert.equal((await packageRequest(f, draft)).status, 409);
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 })).status, 409);
  const next = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  assert.notEqual(next.jobId, job.jobId); assert.equal(next.checkedAssets, 0);
});

for (const change of ['metadata', 'allocation', 'archive', 'restart']) test(`package receipt insertion rejects a ${change} race`, async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  const head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = async key => {
    const object = await head(key);
    if (change === 'metadata') {
      draft.manifest.track.title = 'Race';
      f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(draft.manifest), draft.id);
    }
    if (change === 'allocation') f.sql.prepare('UPDATE admin_draft_assets SET object_key = ? WHERE draft_id = ?').run(key + '-changed', draft.id);
    if (change === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(draft.id);
    if (change === 'restart') assert.equal((await packageRequest(f, draft, 'batches', { restartJobId: job.jobId })).status, 201);
    return object;
  };
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_package_batches').get().n, 0);
});

test('concurrent same-batch requests append only one durable receipt', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  const responses = await Promise.all([0, 1].map(() => packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 })));
  assert(responses.every(response => response.status === 200));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_package_batches').get().n, 1);
});

for (const change of ['archive', 'expiry', 'replacement', 'allocation']) test(`final package insertion fences a ${change} race`, async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 });
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => {
    const statement = prepare(query);
    if (!query.startsWith('INSERT INTO admin_draft_review_jobs')) return statement;
    return { bind: (...values) => ({ run: async () => {
      if (change === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(draft.id);
      if (change === 'expiry') f.sql.prepare('UPDATE admin_draft_package_preparations SET expires_at = 0 WHERE draft_id = ?').run(draft.id);
      if (change === 'replacement') await packageRequest(f, draft, 'batches', { restartJobId: job.jobId });
      if (change === 'allocation') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending' WHERE draft_id = ?").run(draft.id);
      return statement.bind(...values).run();
    } }) };
  };
  assert.equal((await packageRequest(f, draft, 'finish', { jobId: job.jobId })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_jobs').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_reviews').get().n, 0);
});

test('storage failures leave package progress unchanged and internal errors sanitized', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  const head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = () => null;
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 })).status, 409);
  f.env.GIZMAGICK_DRAFTS.head = () => { throw new Error('secret credentials'); };
  const failed = await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 });
  assert.equal(failed.status, 503); assert(!(await failed.text()).includes('credentials'));
  assert.equal((await (await packageRequest(f, draft)).json()).preparation.checkedAssets, 0);
  f.env.GIZMAGICK_DRAFTS.head = head;
  assert.equal((await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 })).status, 200);
});

test('corrupt durable batch fingerprints cannot be assembled into a review package', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 });
  const row = f.sql.prepare('SELECT assets_json FROM admin_draft_package_batches').get();
  const assets = JSON.parse(row.assets_json); assets[0].sha256 = 'a'.repeat(64);
  f.sql.prepare('UPDATE admin_draft_package_batches SET assets_json = ?').run(JSON.stringify(assets));
  assert.equal((await packageRequest(f, draft, 'finish', { jobId: job.jobId })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_draft_review_jobs').get().n, 0);
});

test('preparation and finishing never approve changed audio; the original approval path rechecks the full snapshot', async t => {
  const f = fixture(t); f.env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = 'true';
  const draft = await uploadedDraft(f), job = (await (await packageRequest(f, draft, 'batches', {})).json()).preparation;
  await packageRequest(f, draft, 'batch', { jobId: job.jobId, offset: 0 });
  const packageResult = await (await packageRequest(f, draft, 'finish', { jobId: job.jobId })).json();
  const report = await createReviewReport(packageResult.package, { trackId: draft.manifest.track.id, versionId: draft.manifest.versionId,
    decoderVersions: { opus: '1.7.5', vorbis: '0.1.20' }, valid: true, errors: [], measurements: Object.fromEntries(packageResult.package.snapshot.assets.map(asset =>
      [asset.assetId, { codec: 'opus', channels: 2, sampleRate: 48000, sampleCount: 8640000, containerSampleCount: 8640000,
        initialOverlapSamples: 0, durationSeconds: 180, byteLength: asset.byteLength, sha256: asset.sha256 }])) });
  // Contract-only synthetic measurements are NOT decoder evidence.
  [...f.objects.values()][0].etag = 'changed-etag';
  assert.equal((await packageRequest(f, draft, 'finish', { jobId: job.jobId })).status, 200);
  const attest = () => f.request(`/api/admin/drafts/${draft.id}/attest-review`, { method: 'POST', body: { report, policy: REVIEW_POLICY, provenanceConfirmed: true } });
  assert.equal((await attest()).status, 409);
  delete [...f.objects.values()][0].etag;
  assert.equal((await attest()).status, 201);
  assert.equal((await packageRequest(f, draft, 'batches', { restartJobId: job.jobId })).status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

for (const count of [129, 256]) test(`private inspection bounds each batch of a ${count}-file draft and writes nothing`, async t => {
  const f = fixture(t);
  const input = count === 129 ? { requestId: crypto.randomUUID(), manifest: JSON.parse(await read('../public/tracks/Testing Time/manifest.json')) } : canonical();
  // Preserve the real graph/paths but use identification-only test bytes, never
  // real audio fingerprints or fabricated decoder evidence.
  if (count === 129) for (const asset of Object.values(input.manifest.assets)) { delete asset.byteLength; delete asset.sha256; }
  if (count === 256) for (let i = 1; i < count; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/variant-${i}.ogg` };
  assert.equal(Object.keys(input.manifest.assets).length, count);
  const draft = await uploadedDraft(f, input), writes = f.sql.prepare('SELECT total_changes() n').get().n;
  let heads = 0, databaseReads = 0, pin, pages = 0, checked = 0;
  const prepare = f.env.GIZMAGICK_DB.prepare;
  f.env.GIZMAGICK_DB.prepare = query => { databaseReads++; return prepare(query); };
  const head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = key => { heads++; return head(key); };
  f.env.GIZMAGICK_DRAFTS.get = f.env.GIZMAGICK_DRAFTS.put = () => assert.fail('Inspection must not read bytes or write');
  f.env.GIZMAGICK_MEDIA.head = () => assert.fail('Inspection must not touch public storage');
  do {
    heads = 0; databaseReads = 0;
    const response = await f.request(inspectionPath(draft, checked, pin));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    const result = await response.json();
    assert.equal(result.batch.offset, checked); assert.equal(result.batch.totalAssets, count);
    assert.equal(result.assets.length, Math.min(16, count - checked)); assert.equal(heads, result.assets.length);
    assert.equal(databaseReads, 4); // Owner read + allocation read, repeated after R2.
    assert.equal(result.batchOnly, true); assert.equal(result.pointInTimeOnly, true);
    assert.equal(result.audioProbed, false); assert.equal(result.publishing, false); assert.equal(result.publicationAuthorized, false);
    assert.equal(result.draftId, draft.id); assert.equal(result.manifestSha256, draft.manifestSha256);
    if (pin) assert.equal(result.allocationSha256, pin);
    pin = result.allocationSha256; checked = result.batch.end; pages++;
    assert.equal(result.batch.nextOffset, checked < count ? checked : null);
    assert(result.assets.every(asset => !Object.hasOwn(asset, 'objectKey')));
  } while (checked < count);
  assert.equal(pages, Math.ceil(count / 16));
  heads = 0;
  assert.equal((await f.request(inspectionPath(draft, Math.ceil(count / 16) * 16, pin))).status, 400);
  assert.equal(heads, 0);
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n, writes);
  for (const table of ['admin_draft_review_jobs', 'admin_draft_reviews', 'admin_publications', 'library_tracks']) {
    assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
});

test('inspection validates cursors before storage access and preserves ownership/method gates', async t => {
  const f = fixture(t), draft = await uploadedDraft(f);
  f.env.GIZMAGICK_DRAFTS.head = () => assert.fail('Invalid queries must not read R2');
  for (const query of ['', '?offset=01', '?offset=-1', '?offset=1', '?offset=16', '?offset=0&offset=0', '?offset=0&snapshot=bad',
    '?offset=0&unknown=1', '?offset=0&snapshot=' + 'a'.repeat(64) + '&snapshot=' + 'a'.repeat(64)]) {
    assert.equal((await f.request(`/api/admin/drafts/${draft.id}/storage-inspection${query}`)).status, 400);
  }
  assert.equal((await f.request(inspectionPath(draft, 0, 'a'.repeat(64)))).status, 409);
  assert.equal((await f.request(inspectionPath(draft), { principal: other })).status, 404);
  assert.equal((await f.request(inspectionPath(draft), { principal: { ...owner, role: 'user' } })).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await f.request(inspectionPath(draft), { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
});

for (const change of ['missing', 'size', 'custom-checksum', 'native-checksum', 'etag', 'pending', 'allocation-missing', 'constraint', 'invalid-metadata', 'archived']) test(`private inspection rejects ${change}`, async t => {
  const f = fixture(t), draft = await uploadedDraft(f), [key, object] = [...f.objects][0];
  if (change === 'missing') f.objects.delete(key);
  if (change === 'size') object.bytes = ogg().slice(1);
  if (change === 'custom-checksum') object.customMetadata.sha256 = 'a'.repeat(64);
  if (change === 'native-checksum') object.sha256 = 'a'.repeat(64);
  if (change === 'etag') object.etag = '';
  if (change === 'pending') f.sql.prepare("UPDATE admin_draft_assets SET state = 'pending' WHERE draft_id = ?").run(draft.id);
  if (change === 'allocation-missing') f.sql.prepare('DELETE FROM admin_draft_assets WHERE draft_id = ?').run(draft.id);
  if (change === 'constraint') {
    draft.manifest.assets[Object.keys(draft.manifest.assets)[0]].byteLength = 1;
    f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(draft.manifest), draft.id);
  }
  if (change === 'invalid-metadata') f.sql.prepare("UPDATE admin_drafts SET manifest_json = '{}' WHERE id = ?").run(draft.id);
  if (change === 'archived') f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(draft.id);
  assert.equal((await f.request(inspectionPath(draft))).status, 409);
});

for (const change of ['metadata', 'allocation', 'archive', 'owner']) test(`inspection rejects a ${change} race during HEAD checks`, async t => {
  const f = fixture(t), draft = await uploadedDraft(f), head = f.env.GIZMAGICK_DRAFTS.head;
  f.env.GIZMAGICK_DRAFTS.head = async key => {
    const object = await head(key);
    if (change === 'metadata') {
      draft.manifest.track.title = 'Changed';
      f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(draft.manifest), draft.id);
    }
    if (change === 'allocation') f.sql.prepare('UPDATE admin_draft_assets SET object_key = ? WHERE draft_id = ?').run(key + '-changed', draft.id);
    if (change === 'archive') f.sql.prepare("UPDATE admin_drafts SET status = 'archived' WHERE id = ?").run(draft.id);
    if (change === 'owner') f.sql.prepare('UPDATE admin_drafts SET owner_id = ? WHERE id = ?').run(other.id, draft.id);
    return object;
  };
  assert.equal((await f.request(inspectionPath(draft))).status, 409);
});

test('later batches pin allocations, not an atomic all-file R2 snapshot', async t => {
  const f = fixture(t), input = canonical();
  for (let i = 1; i < 17; i++) input.manifest.assets[crypto.randomUUID()] = { path: `audio/variant-${i}.ogg` };
  const draft = await uploadedDraft(f, input);
  const first = await (await f.request(inspectionPath(draft))).json();
  const firstId = first.assets[0].assetId;
  const key = f.sql.prepare('SELECT object_key FROM admin_draft_assets WHERE draft_id = ? AND asset_id = ?').get(draft.id, firstId).object_key;
  f.objects.delete(key); // Earlier R2 objects are deliberately NOT rechecked in later batches.
  const later = await f.request(inspectionPath(draft, 16, first.allocationSha256));
  assert.equal(later.status, 200); assert.equal((await later.json()).batchOnly, true);
  draft.manifest.track.title = 'Changed between batches';
  f.sql.prepare('UPDATE admin_drafts SET manifest_json = ? WHERE id = ?').run(JSON.stringify(draft.manifest), draft.id);
  f.env.GIZMAGICK_DRAFTS.head = () => assert.fail('Stale pins must be rejected before R2');
  assert.equal((await f.request(inspectionPath(draft, 16, first.allocationSha256))).status, 409);
});

test('inspection HEAD returns no body and storage failures are sanitized', async t => {
  const f = fixture(t), draft = await uploadedDraft(f);
  const response = await f.request(inspectionPath(draft), { method: 'HEAD' });
  assert.equal(response.status, 200); assert.equal(await response.text(), '');
  f.env.GIZMAGICK_DRAFTS.head = () => { throw new Error('secret storage credentials'); };
  const failed = await f.request(inspectionPath(draft));
  assert.equal(failed.status, 503); assert(!String(await failed.text()).includes('credentials'));
  f.env.GIZMAGICK_DRAFT_UPLOADS_ENABLED = 'false';
  assert.equal((await f.request(inspectionPath(draft))).status, 503);
});

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

test('real UglyOnPurpose preparation saves through ordinary private editing and needs a fresh measured review', async t => {
  const f = fixture(t); f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = 'true';
  const source = await originalInput('BleepBloop UglyOnPurpose');
  const created = await importOriginal(f, source); assert.equal(created.status, 201);
  const draft = await created.json(), root = new URL(`../public${catalog[source.legacyKey].basePath}/`, import.meta.url);
  for (const [id, asset] of Object.entries(draft.manifest.assets)) {
    assert.equal((await f.upload(draft, new Uint8Array(await readFile(new URL(asset.path, root))), id)).status, 200);
  }
  const oldJob = await (await f.request(`/api/admin/drafts/${draft.id}/review-package`, { method: 'POST', body: {} })).json();
  const before = [...f.objects.entries()];
  const proposal = await prepareClipEnds(draft.manifest, fileURLToPath(root));
  assert.equal(proposal.valid, true, JSON.stringify(proposal.errors));
  assert.equal(proposal.changes.length, 1);
  // A preparation proposal is deliberately not a review report.
  const attest = report => f.request(`/api/admin/drafts/${draft.id}/attest-review`, {
    method: 'POST', body: { report, policy: REVIEW_POLICY, provenanceConfirmed: true } });
  assert.equal((await attest(proposal)).status, 400);
  const input = metadataInput(draft);
  for (const change of proposal.changes) input.manifest.clips[change.clipId].clipEnd = change.to;
  const response = await edit(f, draft, input); assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  assert.notEqual(saved.manifestSha256, draft.manifestSha256); assert.equal(saved.review, null);
  assert.equal(saved.manifest.versionId, draft.manifest.versionId);
  assert.deepEqual(saved.manifest.assets, draft.manifest.assets); assert.deepEqual([...f.objects.entries()], before);
  const decoded = await probeManifest(saved.manifest, fileURLToPath(root)); assert.equal(decoded.valid, true);
  const oldReport = await createReviewReport(oldJob, createProbeReport(draft.manifest, decoded));
  assert.equal((await attest(oldReport)).status, 409);
  const job = await (await f.request(`/api/admin/drafts/${draft.id}/review-package`, { method: 'POST', body: {} })).json();
  const report = await createReviewReport(job, createProbeReport(saved.manifest, decoded));
  assert.equal((await attest(report)).status, 201);
  assert.equal((await edit(f, saved)).status, 409); // Attested metadata is still locked.
  const provenance = f.sql.prepare('SELECT * FROM admin_original_imports WHERE draft_id = ?').get(draft.id);
  assert.equal(provenance.source_manifest_sha256, hash(JSON.stringify(source.sourceManifest)));
  assert.equal(JSON.parse(provenance.source_manifest_json).clips.Main_a.clipEnd, 16.153855);
  assert.equal((await originalSource(source.legacyKey)).clips.Main_a.clipEnd, 16.153855);
  assert.equal(f.sql.prepare('SELECT visibility FROM library_tracks WHERE id = ?').get(draft.manifest.track.id).visibility, 'private');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_track_versions').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 0);
});

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
  f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED = 'true';
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

test('original migrations preserve populated pre-original legacy and bounded publications without replaying any write', async t => {
  const r = await finalReady(t, { boundedReview: true, originalMigration: false }), { f, ready, intent, pass } = r;
  assert.equal((await finalRequest(f, ready.draft, finalBatch(intent, pass))).status, 200);
  assert.equal((await finalRequest(f, ready.draft, finalCommit(intent, pass))).status, 200);
  const input = canonical(); input.manifest.track.id = crypto.randomUUID(); input.manifest.versionId = crypto.randomUUID();
  const legacy = await readyReview(f, input); assert.equal((await legacy.attest()).status, 201);
  f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED = 'true';
  const started = await startPublication(f, legacy); assert.equal(started.status, 201);
  const publication = (await started.json()).publication;
  for (let step = 0; step < 3; step++) assert.equal((await publicationStep(f, legacy, publication.id)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM library_tracks').get().n, 2);
  const tables = f.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rows = (name, columns) => f.sql.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
  const before = tables.map(({ name }) => {
    const columns = f.sql.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name);
    return { name, columns, rows: rows(name, columns) };
  });
  const finalGuard = f.sql.prepare("SELECT sql FROM sqlite_master WHERE name = 'admin_bounded_final_commit_guard'").get().sql;
  const publicObjects = [...r.storage.objects.entries()], privateObjects = [...f.objects.entries()];
  const publicCatalog = await (await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env)).json();
  for (const migration of migrations.slice(9)) {
    f.sql.exec('BEGIN;');
    try { for (const statement of unstable_splitSqlQuery(migration)) f.sql.exec(statement); f.sql.exec('COMMIT;'); }
    catch (error) { f.sql.exec('ROLLBACK;'); throw error; }
  }
  for (const table of before) assert.deepEqual(rows(table.name, table.columns), table.rows, table.name);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_drafts WHERE original_legacy_key IS NOT NULL').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_original_imports').get().n, 0);
  assert.equal(f.sql.prepare("SELECT sql FROM sqlite_master WHERE name = 'admin_bounded_final_commit_guard'").get().sql, finalGuard);
  assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(f.sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(await (await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env)).json(), publicCatalog);
  for (const bucket of [f.env.GIZMAGICK_DRAFTS, f.env.GIZMAGICK_MEDIA]) {
    bucket.get = bucket.head = bucket.put = () => assert.fail('Completed status recovery must not access R2');
  }
  for (const flag of ['GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED']) f.env[flag] = 'false';
  const status = await intentRequest(f, ready.draft); assert.equal(status.status, 200);
  assert.equal((await status.json()).intent.state, 'published');
  for (const table of before) assert.deepEqual(rows(table.name, table.columns), table.rows, table.name);
  assert.deepEqual([...r.storage.objects.entries()], publicObjects); assert.deepEqual([...f.objects.entries()], privateObjects);
});

test('private original intake with planning gate closed exposes editing but rejects every publication operation', async t => {
  const f = fixture(t), config = await read('../../worker/wrangler.toml');
  Object.assign(f.env, Object.fromEntries([...config.matchAll(/^(GIZMAGICK_[A-Z_]+)\s*=\s*"([^"]*)"/gm)].map(([, key, value]) => [key, value])));
  assert.equal(f.env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED, 'true'); // Explicitly authorized private-only rollout.
  f.env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED = 'false'; // Closed-gate compatibility; actual planning config is guarded separately.
  f.env.GIZMAGICK_PUBLICATION_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = f.env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = 'false';
  for (const flag of ['GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED', 'GIZMAGICK_PUBLICATION_ENABLED', 'GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED', 'GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED', 'GIZMAGICK_LEGACY_PUBLICATION_ENABLED']) assert.equal(f.env[flag], 'false');
  const noStorage = () => assert.fail('Intake/status and disabled publishers must not access either bucket');
  for (const bucket of [f.env.GIZMAGICK_DRAFTS, f.env.GIZMAGICK_MEDIA]) bucket.head = bucket.get = bucket.put = noStorage;
  const html = await (await f.request('/admin')).text();
  for (const id of ['original-fields', 'metadata-editor', 'clip-ends-export', 'clip-ends-file', 'clip-ends-apply', 'package-panel', 'verification-panel']) assert(html.includes(`id="${id}"`), id);
  for (const id of ['publication-panel', 'intent-copy', 'final-panel']) assert(!html.includes(`id="${id}"`), id);
  const capabilities = (await (await f.request('/api/admin/session')).json()).capabilities;
  assert.equal(capabilities.originalImports, true); assert.equal(capabilities.originalPublishing, false); assert.equal(capabilities.publishing, false);
  const list = await f.request('/api/admin/original-imports'); assert.equal(list.status, 200);
  assert.equal((await list.json()).originals.length, 13);
  const imported = await importOriginal(f, await originalInput()); assert.equal(imported.status, 201);
  const draft = await imported.json(); assert.equal(draft.originalImport.publishingSupported, false);
  assert.equal(draft.metadataEditable, true); assert.equal(draft.review, null);
  for (const route of ['publication-preview', 'publication', 'publication-step', 'publication-intent', 'publication-final']) {
    const blocked = await f.request(`/api/admin/drafts/${draft.id}/${route}`, { method: 'POST', body: { publicationConfirmed: true } });
    assert.equal(blocked.status, 409, route); assert.equal((await blocked.json()).code, 'ORIGINAL_PRIVATE_ONLY');
  }
  assert.equal((await (await handleLibraryRequest(new Request('https://app.example.com/api/library/catalog'), f.env)).json()).tracks[trackName], undefined);
  for (const table of ['admin_draft_assets', 'admin_draft_reviews', 'admin_publications', 'admin_publication_objects', 'admin_publication_commits', 'library_track_versions']) assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  const count = f.sql.prepare('SELECT COUNT(*) n FROM admin_original_imports').get().n;
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await f.request(`/api/admin/drafts/${draft.id}`)).status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_original_imports').get().n, count);
});

for (const [name, flag] of [['missing', undefined], ['false', 'false'], ['uppercase', 'TRUE'], ['empty', ''], ['boolean', true], ['numeric', 1]]) {
  test(`legacy publisher fails closed with ${name} opt-in, including an existing pending intent`, async t => {
    const { f, ready, publication, storage } = await startedPublisher(t);
    if (flag === undefined) delete f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED;
    else f.env.GIZMAGICK_LEGACY_PUBLICATION_ENABLED = flag;
    f.env.GIZMAGICK_DRAFTS.head = f.env.GIZMAGICK_DRAFTS.get = storage.bucket.head = storage.bucket.put = () => assert.fail('Disabled legacy path must not access R2');
    assert.equal((await startPublication(f, ready)).status, 503);
    assert.equal((await publicationStep(f, ready, publication.id)).status, 503);
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await f.request(`/api/admin/drafts/${ready.draft.id}/publication`, { method })).status, 503);
    }
    assert.equal((await (await f.request('/api/admin/session')).json()).capabilities.publishing, false);
    assert(!(await (await f.request('/admin')).text()).includes('id="publication-panel"'));
    assert.equal(storage.objects.size, 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM admin_publications').get().n, 1);
    for (const table of ['admin_publication_objects', 'admin_publication_commits', 'library_tracks']) {
      assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
  });
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
