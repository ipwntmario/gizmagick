import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { convertLegacyTrack } from '../scripts/lib/track-manifests.mjs';
import { REVIEW_POLICY, createReviewReport } from '../../shared/draft-review.js';

async function bundledWorker(packager) {
  if (packager === 'wrangler') {
    const directory = await mkdtemp(join(tmpdir(), 'gizmagick-admin-test-'));
    try {
      await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
        'deploy', '--dry-run', '--outdir', directory, '--config',
        fileURLToPath(new URL('../../worker/wrangler.toml', import.meta.url)),
      ], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60000 });
      return await readFile(join(directory, 'index.js'), 'utf8');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: true, lib: { entry: fileURLToPath(new URL('../../worker/src/index.js', import.meta.url)), formats: ['es'] } },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  return output.find(chunk => chunk.type === 'chunk' && chunk.isEntry).code;
}

async function verifyBrowserInitialization(html) {
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', value: '', checked: false, files: [], disabled: false, listeners: new Map(),
      addEventListener(event, callback) { this.listeners.set(event, callback); },
      replaceChildren() {}, append() {},
    });
    return elements.get(id);
  };
  const calls = [];
  const draft = { id: crypto.randomUUID(), title: 'Runtime clip ends', status: 'draft', metadataEditable: true, review: null,
    manifestSha256: 'a'.repeat(64), missingAssets: ['a'], uploads: [], warnings: [],
    originalImport: { legacyKey: 'Runtime fixture', publishingSupported: false },
    manifest: { track: { id: crypto.randomUUID() }, versionId: crypto.randomUUID(), assets: { a: { path: 'audio/a.ogg' } },
      clips: { clip: { assetsByMode: { base: 'a' }, loopStart: 0, loopPoint: 9, clipEnd: 20 } } } };
  // Execute the emitted page script, not its unbundled source. Browser globals
  // are explicit; no Worker/esbuild helpers are available in this fresh realm.
  runInNewContext(scripts[0][1], {
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => element(crypto.randomUUID()) },
    crypto, TextEncoder, File: class File {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, redirected: false, headers: { get: () => 'application/json' },
        json: async () => options.method === 'POST' && path === '/api/admin/drafts' ? structuredClone(draft) : { drafts: [] } };
    },
  }, { timeout: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('status').textContent, 'Admin intake is ready. Publishing requires an eligible draft and explicit confirmation for every step.');
  assert.equal(element('draft-list').textContent, 'No drafts yet.');
  assert.equal(element('upload').disabled, true);
  assert.equal(element('archive').disabled, true);
  assert.equal(element('review-package').disabled, true);
  assert.equal(element('attest-review').disabled, true);
  assert.equal(element('metadata-editor').disabled, true);
  assert.equal(element('save-metadata').disabled, true);
  assert.equal(element('publication-action').disabled, true);
  assert.equal(element('publication-confirm').disabled, true);
  assert.equal(element('publication-refresh').disabled, true);
  assert.equal(element('publication-check').disabled, true);
  assert.equal(element('package-start').disabled, true);
  assert.equal(element('package-next').disabled, true);
  assert.equal(element('verification-start').disabled, true);
  assert.equal(element('verification-attest').disabled, true);
  assert.equal(element('intent-prepare').disabled, true);
  assert.equal(element('intent-reserve').disabled, true);
  assert(element('intent-refresh').listeners.has('click'));
  assert(html.includes('Final verification and catalog publication'));
  assert.equal(element('final-start').disabled, true);
  assert.equal(element('final-commit').disabled, true);
  assert(element('final-refresh').listeners.has('click'));
  assert.equal(element('intent-copy').disabled, true);
  assert.equal(element('intent-copy-confirm').disabled, true);
  assert(element('intent-copy').listeners.has('click'));
  assert(element('verification-refresh').listeners.has('click'));
  assert(html.includes('Earlier objects are not rechecked at final confirmation'));
  assert(element('package-refresh').listeners.has('click'));
  assert.equal(element('inspection-next').disabled, true);
  assert.equal(element('inspection-reset').disabled, true);
  assert(element('inspection-next').listeners.has('click'));
  assert(html.includes('finishing a pass is NOT an approval'));
  assert(element('publication-action').listeners.has('click'));
  assert(element('publication-refresh').listeners.has('click'));
  assert(html.includes('Each copy makes a file publicly downloadable by URL'));
  assert(element('sections-file').listeners.has('change'));
  assert(element('create-draft').listeners.has('submit'));
  assert(html.includes('id="original-fields"'));
  assert(element('original-key').listeners.has('change'));
  assert(element('audio-files').listeners.has('change'));
  assert(element('upload').listeners.has('click'));
  assert(element('review-report').listeners.has('change'));
  assert(element('attest-review').listeners.has('click'));
  assert(element('save-metadata').listeners.has('click'));
  for (const id of ['clip-ends-export', 'clip-ends-file', 'clip-ends-apply']) assert.equal(element(id).disabled, true);
  assert.deepEqual(calls.map(call => [call.path, call.options.method]), [['/api/admin/drafts', 'GET']]);
  // Exercise the serialized policy dependency in the actual bundled page, not
  // just in source-level tests. No bundler/module helpers exist in this realm.
  element('source').value = 'manifest';
  element('manifest-file').files = [{ size: 1000, text: async () => JSON.stringify(draft.manifest) }];
  element('create-draft').listeners.get('submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('clip-ends-file').disabled, false, element('status').textContent);
  const proposal = { reportVersion: 1, scope: 'local-metadata-preparation', policy: 'gizmagick-clip-ends-v1', publishing: false,
    approval: false, valid: true, errors: [], trackId: draft.manifest.track.id, versionId: draft.manifest.versionId,
    sourceManifestSha256: createHash('sha256').update(JSON.stringify(draft.manifest)).digest('hex'),
    measurements: { a: { durationSeconds: 10, byteLength: 100, sha256: 'b'.repeat(64) } },
    changes: [{ clipId: 'clip', from: 20, to: 10, reason: 'too-long' }] };
  const count = calls.length;
  element('clip-ends-file').files = [{ size: 2000, text: async () => JSON.stringify(proposal) }];
  await element('clip-ends-file').listeners.get('change')();
  assert.equal(element('clip-ends-apply').disabled, false, element('status').textContent);
  assert.equal(JSON.parse(element('metadata-editor').value).clips.clip.clipEnd, 20);
  await element('clip-ends-apply').listeners.get('click')();
  assert.equal(JSON.parse(element('metadata-editor').value).clips.clip.clipEnd, 10, element('status').textContent);
  assert.equal(calls.length, count); assert.equal(element('attest-review').disabled, true);
  assert.match(element('status').textContent, /UNSAVED/);
}

for (const packager of ['vite', 'wrangler']) test(`the ${packager}-bundled Worker verifies tokens, boots its browser script, and stores private audio`, async () => {
  const code = await bundledWorker(packager);
  const issuer = 'https://gizmagick-runtime-test.cloudflareaccess.com';
  const audience = 'b'.repeat(64);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'runtime-key', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issue = email => {
    const input = `${encode({ alg: 'RS256', kid: publicKey.kid })}.${encode({
      iss: issuer, aud: [audience], sub: '11111111-1111-4111-8111-111111111111',
      email, type: 'app', iat: now - 60, nbf: now - 60, exp: now + 3600,
    })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  };
  const outbound = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: code, cf: false, compatibilityDate: '2024-09-01',
    d1Databases: ['GIZMAGICK_DB'], r2Buckets: ['GIZMAGICK_DRAFTS', 'GIZMAGICK_MEDIA'],
    bindings: { GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED: 'true', GIZMAGICK_ORIGINAL_IMPORTS_ENABLED: 'true', GIZMAGICK_PUBLICATION_INTENTS_ENABLED: 'true', GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED: 'true', GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED: 'true', GIZMAGICK_DRAFT_UPLOADS_ENABLED: 'true', GIZMAGICK_DRAFT_REVIEWS_ENABLED: 'true', GIZMAGICK_DRAFT_METADATA_ENABLED: 'true', GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED: 'true', GIZMAGICK_PUBLICATION_ENABLED: 'true', GIZMAGICK_ACCESS_TEAM_DOMAIN: issuer, GIZMAGICK_ACCESS_AUD: audience,
      GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED: 'true', GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED: 'true', GIZMAGICK_COMPACT_PUBLIC_COPY_ENABLED: 'true', GIZMAGICK_LEGACY_PUBLICATION_ENABLED: 'true', GIZMAGICK_ADMIN_ORIGIN: 'https://admin.example.com', GIZMAGICK_ADMIN_EMAILS: 'admin@example.com' },
    outboundService: async req => {
      outbound.push(req.url);
      assert.equal(req.url, `${issuer}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [publicKey] }), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    const db = await mf.getD1Database('GIZMAGICK_DB');
    // D1 exec() is line-oriented. Each migration is a sequence of SQL statements.
    for (const name of ['0001_gizmagick_library.sql', '0002_gizmagick_drafts.sql', '0003_gizmagick_draft_reviews.sql', '0004_gizmagick_publications.sql', '0005_gizmagick_review_package_batches.sql', '0006_gizmagick_review_verification_batches.sql', '0007_gizmagick_publication_intents.sql', '0008_gizmagick_bounded_public_copy.sql', '0009_gizmagick_bounded_publication_final.sql', '0010_gizmagick_original_imports.sql', '0011_gizmagick_original_publication.sql']) {
      const migration = await readFile(new URL(`../../worker/migrations/${name}`, import.meta.url), 'utf8');
      await db.exec(migration.replace(/^--.*$/gm, '').replaceAll('\n', ' '));
    }
    const token = issue('admin@example.com');
    const request = (path, jwt = token, extra = {}) => mf.dispatchFetch(`https://admin.example.com${path}`, {
      ...extra, headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...extra.headers },
    });
    const allowed = await request('/api/admin/session');
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.principal.email, 'admin@example.com');
    assert.equal(body.capabilities.reviews, true);
    assert.equal(body.capabilities.metadata, true);
    assert.equal(body.capabilities.publicationPreflight, true);
    assert.equal(body.capabilities.publishing, true);
    assert.equal(body.capabilities.batchPackages, true);
    assert.equal(body.capabilities.batchReview, true);
    assert.equal(body.capabilities.publicationIntents, true);
    assert.equal(body.capabilities.originalImports, true);
    assert.match(body.principal.id, /^access:[a-f0-9]{64}$/);
    const page = await request('/admin');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert(html.includes('Administrator verified'));
    await verifyBrowserInitialization(html);
    assert.equal((await request('/api/admin/session', null)).status, 401);
    assert.equal((await request('/api/admin/session', issue('member@example.com'))).status, 403);
    assert.equal((await request('/api/admin/session', `${token.slice(0, -20)}invalidsignature`)).status, 401);
    assert.equal((await request('/api/admin/uploads', token, { method: 'POST' })).status, 403);
    assert.equal((await request('/health', null)).status, 200);
    const read = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
    const catalog = await read('../public/trackData.json');
    const track = catalog.tracks["Lena's Home"];
    const manifest = convertLegacyTrack("Lena's Home", track,
      await read(`../public${track.basePath}/clipData.json`), await read(`../public${track.basePath}/sectionData.json`));
    const writeHeaders = { Origin: 'https://admin.example.com', 'X-Gizmagick-Admin-Request': '1', 'Content-Type': 'application/json' };
    const created = await request('/api/admin/drafts', token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ requestId: crypto.randomUUID(), manifest }) });
    assert.equal(created.status, 201, await created.clone().text());
    let draft = await created.json();
    const metadataUrl = `/api/admin/drafts/${draft.id}/metadata`;
    const edits = { expectedManifestSha256: draft.manifestSha256, manifest: structuredClone(draft.manifest) };
    edits.manifest.track.title = 'Runtime edited private draft';
    assert.equal((await request(metadataUrl, null, { method: 'POST', headers: writeHeaders, body: JSON.stringify(edits) })).status, 401);
    assert.equal((await request(metadataUrl, token, { method: 'POST', body: JSON.stringify(edits) })).status, 403);
    assert.equal((await request(metadataUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders, body: JSON.stringify(edits) })).status, 403);
    const edited = await request(metadataUrl, token, { method: 'POST', headers: writeHeaders, body: JSON.stringify(edits) });
    assert.equal(edited.status, 200, await edited.clone().text());
    draft = await edited.json();
    assert.equal(draft.title, 'Runtime edited private draft');
    assert.equal((await (await request(`/api/admin/drafts/${draft.id}`)).json()).manifestSha256, draft.manifestSha256);
    const assetId = Object.keys(draft.manifest.assets)[0];
    const bytes = new Uint8Array(await readFile(new URL(`../public${track.basePath}/${draft.manifest.assets[assetId].path}`, import.meta.url)));
    const uploadUrl = `/api/admin/drafts/${draft.id}/assets/${assetId}`;
    assert.equal((await request(uploadUrl, null, { method: 'PUT', headers: writeHeaders, body: bytes })).status, 401);
    assert.equal((await request(uploadUrl, token, { method: 'PUT', body: bytes })).status, 403);
    const upload = await request(uploadUrl, token, { method: 'PUT', headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal(upload.status, 200, await upload.clone().text());
    assert.equal((await upload.json()).audioProbed, false);
    const download = await request(uploadUrl);
    assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await request(uploadUrl, issue('member@example.com'))).status, 403);
    const resumed = await request(`/api/admin/drafts/${draft.id}`);
    assert.equal((await resumed.json()).missingAssets.length, 0);
    const inspectionUrl = `/api/admin/drafts/${draft.id}/storage-inspection?offset=0`;
    assert.equal((await request(inspectionUrl, null)).status, 401);
    assert.equal((await request(inspectionUrl, issue('member@example.com'))).status, 403);
    assert.equal((await request(inspectionUrl, token, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const inspectionResponse = await request(inspectionUrl);
    assert.equal(inspectionResponse.status, 200, await inspectionResponse.clone().text());
    assert.equal(inspectionResponse.headers.get('Cache-Control'), 'private, no-store');
    const inspection = await inspectionResponse.json();
    assert.equal(inspection.manifestSha256, draft.manifestSha256);
    assert.equal(inspection.assets[0].byteLength, bytes.length);
    assert.equal(inspection.assets[0].assetId, assetId);
    assert.equal(inspection.batch.nextOffset, null); assert.equal(inspection.batchOnly, true);
    assert.equal(inspection.publicationAuthorized, false); assert.equal(inspection.audioProbed, false);
    const inspectionHead = await request(inspectionUrl, token, { method: 'HEAD' });
    assert.equal(inspectionHead.status, 200); assert.equal(await inspectionHead.text(), '');
    const inspectionPost = await request(inspectionUrl, token, { method: 'POST', headers: writeHeaders });
    assert.equal(inspectionPost.status, 405); assert.equal(inspectionPost.headers.get('Allow'), 'GET, HEAD');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_draft_review_jobs').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_publications').first()).n, 0);
    const packageUrl = `/api/admin/drafts/${draft.id}/review-package`;
    assert.equal((await request(packageUrl, null, { method: 'POST', headers: writeHeaders })).status, 401);
    assert.equal((await request(packageUrl, token, { method: 'POST' })).status, 403);
    assert.equal((await request(packageUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders })).status, 403);
    const batchUrl = `/api/admin/drafts/${draft.id}/review-package-batches`;
    assert.equal((await request(batchUrl, null)).status, 401);
    assert.equal((await request(batchUrl, issue('member@example.com'))).status, 403);
    assert.equal((await request(batchUrl, token, { method: 'POST', body: '{}' })).status, 403);
    const startPackage = await request(batchUrl, token, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(startPackage.status, 201, await startPackage.clone().text());
    const preparation = (await startPackage.json()).preparation;
    const batchResponse = await request(`/api/admin/drafts/${draft.id}/review-package-batch`, token,
      { method: 'POST', headers: writeHeaders, body: JSON.stringify({ jobId: preparation.jobId, offset: 0 }) });
    assert.equal(batchResponse.status, 200, await batchResponse.clone().text());
    assert.equal((await (await request(batchUrl)).json()).preparation.checkedAssets, 1);
    const jobResponse = await request(`/api/admin/drafts/${draft.id}/review-package-finish`, token,
      { method: 'POST', headers: writeHeaders, body: JSON.stringify({ jobId: preparation.jobId }) });
    assert.equal(jobResponse.status, 200, await jobResponse.clone().text());
    const job = (await jobResponse.json()).package;
    assert.equal(job.snapshot.assets[0].byteLength, bytes.length);
    // Run the actual local CLI against a package minted by the actual bundled
    // Worker and R2/D1 simulator, not a fabricated report or bypassed handler.
    const directory = await mkdtemp(join(tmpdir(), 'gizmagick-review-cli-'));
    let report;
    try {
      const packageFile = join(directory, 'review-package.json');
      await writeFile(packageFile, JSON.stringify(job));
      const cli = fileURLToPath(new URL('../scripts/gizmagick-audio-probe.mjs', import.meta.url));
      const trackRoot = fileURLToPath(new URL(`../public${track.basePath}/`, import.meta.url));
      const args = [cli, '--review-package', packageFile, '--track-root', trackRoot];
      const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 30000 });
      report = JSON.parse(stdout);
      assert.equal(report.valid, true); assert.equal(report.draftId, draft.id);
      await writeFile(packageFile, JSON.stringify({ ...job, expiresAt: 0 }));
      await assert.rejects(promisify(execFile)(process.execPath, args), error => error.code === 1 && error.stderr.includes('expired'));
      const altered = structuredClone(job); altered.snapshot.manifest.track.title += '!';
      await writeFile(packageFile, JSON.stringify(altered));
      await assert.rejects(promisify(execFile)(process.execPath, args), error => error.code === 1 && error.stderr.includes('altered'));
    } finally { await rm(directory, { recursive: true, force: true }); }
    const attestUrl = `/api/admin/drafts/${draft.id}/attest-review`;
    const bodyForReview = JSON.stringify({ report, policy: REVIEW_POLICY, provenanceConfirmed: true });
    assert.equal((await request(attestUrl, null, { method: 'POST', headers: writeHeaders, body: bodyForReview })).status, 401);
    assert.equal((await request(attestUrl, token, { method: 'POST', body: bodyForReview })).status, 403);
    assert.equal((await request(attestUrl, token, { method: 'POST', headers: { ...writeHeaders, Origin: 'https://evil.example.com' }, body: bodyForReview })).status, 403);
    assert.equal((await request(attestUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders, body: bodyForReview })).status, 403);
    const approved = await request(attestUrl, token, { method: 'POST', headers: writeHeaders, body: bodyForReview });
    assert.equal(approved.status, 201, await approved.clone().text());
    const approvedBody = await approved.json();
    assert.equal(approvedBody.review.scope, 'administrator-attested');
    assert.equal(approvedBody.review.serverDecoded, false); assert.equal(approvedBody.publishing, false);
    const reopened = await (await request(`/api/admin/drafts/${draft.id}`)).json();
    assert.equal(reopened.review.reportSha256, approvedBody.review.reportSha256);
    assert.equal(reopened.audioProbed, false);
    assert.equal((await request(attestUrl, token, { method: 'POST', headers: writeHeaders, body: bodyForReview })).status, 200);
    assert.equal((await request('/api/admin/publish', token, { method: 'POST', headers: writeHeaders })).status, 405);
    const previewUrl = `/api/admin/drafts/${draft.id}/publication-preview`;
    assert.equal((await request(previewUrl, null)).status, 401);
    assert.equal((await request(previewUrl, issue('member@example.com'))).status, 403);
    assert.equal((await request(previewUrl, token, { headers: { Origin: 'https://evil.example.com' } })).status, 403);
    assert.equal((await request(previewUrl, token, { method: 'POST', headers: writeHeaders })).status, 405);
    const previewResponse = await request(previewUrl);
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json();
    assert.equal(preview.publicationAuthorized, false); assert.equal(preview.publishing, false); assert.equal(preview.serverDecoded, false);
    assert.equal(preview.objects[1].byteLength, bytes.length); assert.equal(preview.trackId, draft.manifest.track.id);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_track_versions').first()).n, 0);
    assert.equal((await (await mf.getR2Bucket('GIZMAGICK_MEDIA')).list()).objects.length, 0);
    // Isolated local publisher: actual native R2 conditional reads/puts and
    // SQLite trigger atomicity, never a remote bucket or production migration.
    const publicationUrl = `/api/admin/drafts/${draft.id}/publication`;
    const publishInput = JSON.stringify({ requestId: crypto.randomUUID(),
      expectedSnapshotSha256: preview.review.snapshotSha256, expectedReportSha256: preview.review.reportSha256,
      publicationConfirmed: true });
    assert.equal((await request(publicationUrl, null, { method: 'POST', headers: writeHeaders, body: publishInput })).status, 401);
    assert.equal((await request(publicationUrl, token, { method: 'POST', body: publishInput })).status, 403);
    assert.equal((await request(publicationUrl, token, { method: 'POST', headers: { ...writeHeaders, Origin: 'https://evil.example.com' }, body: publishInput })).status, 403);
    assert.equal((await request(publicationUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders, body: publishInput })).status, 403);
    assert.equal((await request(publicationUrl, token, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ publicationConfirmed: false }) })).status, 400);
    const started = await request(publicationUrl, token, { method: 'POST', headers: writeHeaders, body: publishInput });
    assert.equal(started.status, 201, await started.clone().text());
    const { publication } = await started.json();
    assert.equal(publication.state, 'pending');
    const stepUrl = `/api/admin/drafts/${draft.id}/publication-step`;
    const stepInput = JSON.stringify({ publicationId: publication.id, publicationConfirmed: true });
    assert.equal((await request(stepUrl, token)).status, 405);
    assert.equal((await request(stepUrl, null, { method: 'POST', headers: writeHeaders, body: stepInput })).status, 401);
    assert.equal((await request(stepUrl, token, { method: 'POST', body: stepInput })).status, 403);
    assert.equal((await request(stepUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders, body: stepInput })).status, 403);
    for (let index = 0; index < 2; index++) {
      const copied = await request(stepUrl, token, { method: 'POST', headers: writeHeaders, body: stepInput });
      assert.equal(copied.status, 200, await copied.clone().text());
      assert.equal((await copied.json()).publication.state, 'pending');
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 0);
    }
    const published = await request(stepUrl, token, { method: 'POST', headers: writeHeaders, body: stepInput });
    assert.equal(published.status, 200, await published.clone().text());
    assert.equal((await published.json()).publication.state, 'published');
    assert.equal((await request(stepUrl, token, { method: 'POST', headers: writeHeaders, body: stepInput })).status, 200);
    assert.equal((await request(publicationUrl, token, { method: 'POST', headers: writeHeaders, body: publishInput })).status, 200);
    const publishedCatalog = await request('/api/library/catalog', null);
    const catalogEntry = (await publishedCatalog.json()).tracks[draft.manifest.track.id];
    assert.equal(catalogEntry.versionId, draft.manifest.versionId);
    const publicBucket = await mf.getR2Bucket('GIZMAGICK_MEDIA');
    const publicManifest = await publicBucket.get(preview.objects[0].key);
    const finalManifest = await publicManifest.json();
    assert.equal(finalManifest.assets[assetId].durationSeconds, 180);
    const publicAudio = await publicBucket.get(preview.objects[1].key);
    assert.deepEqual(new Uint8Array(await publicAudio.arrayBuffer()), bytes);
    assert.equal(publicAudio.httpMetadata.contentType, 'audio/ogg');
    assert.equal(publicAudio.customMetadata.gizmagickPublication, publication.id);
    const publicAudioResponse = await request(`/api/library/media/tracks/${draft.manifest.track.id}/versions/${draft.manifest.versionId}/audio/${encodeURIComponent("Lena's Home.ogg")}`, null);
    assert.equal(publicAudioResponse.status, 200);
    assert.deepEqual(new Uint8Array(await publicAudioResponse.arrayBuffer()), bytes);
    assert.equal((await publicBucket.list()).objects.length, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_publication_commits').first()).n, 1);
    // Real D1 statement/trigger rollback, not just the DatabaseSync mock.
    await db.exec("CREATE TRIGGER simulate_publication_failure BEFORE INSERT ON library_track_versions BEGIN SELECT RAISE(ABORT, 'runtime rollback test'); END;");
    const draft2Response = await request('/api/admin/drafts', token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ requestId: crypto.randomUUID(), manifest }) });
    assert.equal(draft2Response.status, 201);
    const draft2 = await draft2Response.json(), assetId2 = Object.keys(draft2.manifest.assets)[0];
    assert.equal((await request(`/api/admin/drafts/${draft2.id}/assets/${assetId2}`, token,
      { method: 'PUT', headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream' }, body: bytes })).status, 200);
    const job2 = await (await request(`/api/admin/drafts/${draft2.id}/review-package`, token, { method: 'POST', headers: writeHeaders })).json();
    // Same already-decoded real file, rebind its measurements to this isolated
    // second package. This test provenance is not a cloud human attestation.
    const report2 = await createReviewReport(job2, { trackId: draft2.manifest.track.id, versionId: draft2.manifest.versionId,
      decoderVersions: report.decoderVersions, valid: true, errors: [], measurements: { [assetId2]: report.measurements[assetId] } });
    const reviewed2 = await request(`/api/admin/drafts/${draft2.id}/attest-review`, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ report: report2, policy: REVIEW_POLICY, provenanceConfirmed: true }) });
    assert.equal(reviewed2.status, 201, await reviewed2.clone().text());
    const review2 = (await reviewed2.json()).review;
    const input2 = JSON.stringify({ requestId: crypto.randomUUID(), expectedSnapshotSha256: review2.snapshotSha256,
      expectedReportSha256: review2.reportSha256, publicationConfirmed: true });
    const start2 = await request(`/api/admin/drafts/${draft2.id}/publication`, token, { method: 'POST', headers: writeHeaders, body: input2 });
    assert.equal(start2.status, 201, await start2.clone().text());
    const publication2 = (await start2.json()).publication;
    const steps2Url = `/api/admin/drafts/${draft2.id}/publication-step`;
    const steps2Input = JSON.stringify({ publicationId: publication2.id, publicationConfirmed: true });
    for (let i = 0; i < 2; i++) assert.equal((await request(steps2Url, token, { method: 'POST', headers: writeHeaders, body: steps2Input })).status, 200);
    const failedCommit = await request(steps2Url, token, { method: 'POST', headers: writeHeaders, body: steps2Input });
    assert.equal(failedCommit.status, 503);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_track_versions').first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_publication_commits').first()).n, 1);
    assert.equal((await db.prepare('SELECT state FROM admin_publications WHERE id = ?').bind(publication2.id).first()).state, 'pending');
    await db.exec('DROP TRIGGER simulate_publication_failure;');
    assert.equal((await request(steps2Url, token, { method: 'POST', headers: writeHeaders, body: steps2Input })).status, 200);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 2);
    // Separate real-file batched review: it must not enter the publisher.
    const draft3 = await (await request('/api/admin/drafts', token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ requestId: crypto.randomUUID(), manifest }) })).json();
    const assetId3 = Object.keys(draft3.manifest.assets)[0];
    assert.equal((await request(`/api/admin/drafts/${draft3.id}/assets/${assetId3}`, token,
      { method: 'PUT', headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream' }, body: bytes })).status, 200);
    const job3 = await (await request(`/api/admin/drafts/${draft3.id}/review-package`, token, { method: 'POST', headers: writeHeaders })).json();
    const report3 = await createReviewReport(job3, { trackId: draft3.manifest.track.id, versionId: draft3.manifest.versionId,
      decoderVersions: report.decoderVersions, valid: true, errors: [], measurements: { [assetId3]: report.measurements[assetId] } });
    const verifyUrl = `/api/admin/drafts/${draft3.id}/review-verification`;
    assert.equal((await request(verifyUrl, null)).status, 401);
    assert.equal((await request(verifyUrl, issue('member@example.com'))).status, 403);
    assert.equal((await request(verifyUrl, token, { method: 'POST', body: '{}' })).status, 403);
    const start3 = await request(verifyUrl, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ report: report3, policy: REVIEW_POLICY, provenanceConfirmed: true }) });
    assert.equal(start3.status, 200, await start3.clone().text());
    const pass3 = (await start3.json()).verification;
    const batch3 = await request(`/api/admin/drafts/${draft3.id}/review-verification-batch`, token,
      { method: 'POST', headers: writeHeaders, body: JSON.stringify({ verificationId: pass3.id, offset: 0 }) });
    assert.equal(batch3.status, 200, await batch3.clone().text());
    assert.equal((await (await request(verifyUrl)).json()).verification.checkedAssets, 1);
    const attest3 = await request(`/api/admin/drafts/${draft3.id}/attest-review-batched`, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ verificationId: pass3.id, policy: REVIEW_POLICY, provenanceConfirmed: true, batchWindowConfirmed: true }) });
    assert.equal(attest3.status, 201, await attest3.clone().text());
    const review3 = (await attest3.json()).review;
    assert.equal(review3.storageCheckScope, 'bounded-batches');
    const preview3 = await request(`/api/admin/drafts/${draft3.id}/publication-preview`);
    assert.equal(preview3.status, 409); assert.equal((await preview3.json()).code, 'PUBLICATION_PREFLIGHT_BATCH_REVIEW');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 2);
    await assert.rejects(db.prepare('DELETE FROM admin_draft_review_verification_batches WHERE verification_id = ?').bind(pass3.id).run(), /retained/);
    const intentUrl = `/api/admin/drafts/${draft3.id}/publication-intent`;
    assert.equal((await request(intentUrl, null)).status, 401);
    assert.equal((await request(intentUrl, issue('member@example.com'))).status, 403);
    assert.equal((await request(intentUrl, token, { method: 'POST', body: '{}' })).status, 403);
    const prep3Response = await request(intentUrl, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ action: 'prepare', requestId: crypto.randomUUID(), expectedSnapshotSha256: review3.snapshotSha256, expectedReportSha256: review3.reportSha256 }) });
    assert.equal(prep3Response.status, 201, await prep3Response.clone().text());
    const prep3 = (await prep3Response.json()).preparation;
    const ready3 = await request(intentUrl, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ action: 'check-batch', preparationId: prep3.id, offset: 0 }) });
    assert.equal(ready3.status, 200, await ready3.clone().text());
    assert.equal((await (await request(intentUrl)).json()).preparation.checkedObjects, 2);
    const reserved3 = await request(intentUrl, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ action: 'reserve', preparationId: prep3.id, publicationConfirmed: true, batchWindowConfirmed: true }) });
    assert.equal(reserved3.status, 201, await reserved3.clone().text());
    const intent3 = (await reserved3.json()).intent;
    assert.equal(intent3.nextAction, 'copy-one-object'); assert.equal(intent3.continuationBlocked, false);
    const legacyRead3 = await request(`/api/admin/drafts/${draft3.id}/publication`);
    assert.equal(legacyRead3.status, 409); assert.equal((await legacyRead3.json()).code, 'PUBLICATION_BOUNDED_WORKFLOW');
    await assert.rejects(db.prepare('INSERT INTO admin_publication_objects (publication_id, ordinal, etag) VALUES (?, 0, ?)').bind(prep3.id, 'forged').run(), /Bounded copy changed/);
    const copyBody3 = ordinal => JSON.stringify({ action: 'copy-one', publicationId: intent3.id, ordinal,
      expectedPlanSha256: intent3.planSha256, publicationConfirmed: true });
    assert.equal((await request(intentUrl, null, { method: 'POST', headers: writeHeaders, body: copyBody3(0) })).status, 401);
    assert.equal((await request(intentUrl, token, { method: 'POST', body: copyBody3(0) })).status, 403);
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const copied3 = await request(intentUrl, token, { method: 'POST', headers: writeHeaders, body: copyBody3(ordinal) });
      assert.equal(copied3.status, 200, await copied3.clone().text());
      assert.equal((await copied3.json()).intent.copiedObjects, ordinal + 1);
    }
    const repeated3 = await request(intentUrl, token, { method: 'POST', headers: writeHeaders, body: copyBody3(0) });
    assert.equal((await repeated3.json()).intent.copiedObjects, 2);
    const stored3 = await db.prepare('SELECT plan_json FROM admin_publications WHERE id = ?').bind(intent3.id).first();
    const plan3 = JSON.parse(stored3.plan_json), finalStatus3 = await (await request(intentUrl)).json();
    assert.equal(finalStatus3.intent.nextAction, null); assert.equal(finalStatus3.catalogCommitEnabled, false);
    for (const object of plan3.objects) {
      const publicObject = await (await mf.getR2Bucket('GIZMAGICK_MEDIA')).get(object.key);
      assert.equal(publicObject.customMetadata.gizmagickPlan, intent3.planSha256);
      assert.equal(publicObject.size, object.byteLength);
      assert.equal(createHash('sha256').update(new Uint8Array(await publicObject.arrayBuffer())).digest('hex'), object.sha256);
    }
    await assert.rejects(db.prepare('INSERT INTO admin_publication_commits (publication_id, lease_token) VALUES (?, ?)').bind(prep3.id, 'forged').run(), /Bounded final verification|Publication changed before commit/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_publication_objects WHERE publication_id = ?').bind(prep3.id).first()).n, 2);
    const finalUrl3 = `/api/admin/drafts/${draft3.id}/publication-final`, finalBase3 = { publicationId: intent3.id, expectedPlanSha256: intent3.planSha256 };
    assert.equal((await request(finalUrl3, null)).status, 401);
    assert.equal((await request(finalUrl3, issue('member@example.com'))).status, 403);
    assert.equal((await request(finalUrl3, token, { method: 'POST', body: '{}' })).status, 403);
    const startFinal3 = await request(finalUrl3, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ ...finalBase3, action: 'start', requestId: crypto.randomUUID() }) });
    assert.equal(startFinal3.status, 201, await startFinal3.clone().text());
    const finalPass3 = (await startFinal3.json()).verification;
    const commitInput3 = JSON.stringify({ ...finalBase3, action: 'commit', passId: finalPass3.id, publicationConfirmed: true, batchWindowConfirmed: true });
    assert.equal((await request(finalUrl3, token, { method: 'POST', headers: writeHeaders, body: commitInput3 })).status, 409);
    const finalBatch3 = await request(finalUrl3, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ ...finalBase3, action: 'check-batch', passId: finalPass3.id, offset: 0 }) });
    assert.equal(finalBatch3.status, 200, await finalBatch3.clone().text());
    assert.equal((await finalBatch3.json()).verification.checkedObjects, 2);
    const committed3 = await request(finalUrl3, token, { method: 'POST', headers: writeHeaders, body: commitInput3 });
    assert.equal(committed3.status, 200, await committed3.clone().text());
    const published3 = (await committed3.json()).publication;
    assert.equal(published3.state, 'published'); assert.equal(published3.finalAudit.storageCheckScope, 'bounded-batches');
    assert.equal((await request(finalUrl3, token, { method: 'POST', headers: writeHeaders, body: commitInput3 })).status, 200);
    assert.equal((await (await request(intentUrl)).json()).intent.state, 'published');
    const finalCatalog3 = await (await request('/api/library/catalog', null)).json();
    assert.equal(finalCatalog3.tracks[intent3.trackId].versionId, intent3.versionId);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks').first()).n, 3);
    await assert.rejects(db.prepare('DELETE FROM admin_publication_final_batches WHERE pass_id = ?').bind(finalPass3.id).run(), /retained/);
    assert.equal(outbound.length, 1);
    // Identity-preserving initial import, using the actual bundled route and D1
    // transaction. Existing randomly identified smoke tests remain independent.
    const sourceManifest = await read(`../public${track.basePath}/manifest.json`);
    const originalBody = JSON.stringify({ requestId: crypto.randomUUID(), legacyKey: "Lena's Home", expectedOwnerId: body.principal.id,
      sourceManifest, importConfirmed: true });
    assert.equal((await request('/api/admin/original-imports', null, { method: 'POST', headers: writeHeaders, body: originalBody })).status, 401);
    assert.equal((await request('/api/admin/original-imports', token, { method: 'POST', body: originalBody })).status, 403);
    const publicCount = (await publicBucket.list()).objects.length;
    const imported = await request('/api/admin/original-imports', token, { method: 'POST', headers: writeHeaders, body: originalBody });
    assert.equal(imported.status, 201, await imported.clone().text());
    const original = await imported.json();
    assert.equal(original.manifest.track.id, sourceManifest.track.id);
    assert.notEqual(original.manifest.versionId, sourceManifest.versionId);
    assert.equal(original.originalImport.legacyKey, "Lena's Home");
    assert.equal((await request('/api/admin/original-imports', token, { method: 'POST', headers: writeHeaders, body: originalBody })).status, 200);
    assert.equal((await request(`/api/admin/drafts/${original.id}/assets/${Object.keys(original.manifest.assets)[0]}`, token,
      { method: 'PUT', headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream' }, body: bytes })).status, 200);
    const unreviewedOriginal = await request(`/api/admin/drafts/${original.id}/publication-intent`, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ action: 'prepare', requestId: crypto.randomUUID(), expectedSnapshotSha256: '0'.repeat(64), expectedReportSha256: '0'.repeat(64) }) });
    assert.equal(unreviewedOriginal.status, 409);
    assert.equal((await unreviewedOriginal.json()).code, 'INTENT_REVIEW');
    assert.equal((await publicBucket.list()).objects.length, publicCount);
    const reserved = await db.prepare('SELECT * FROM library_tracks WHERE id = ?').bind(sourceManifest.track.id).first();
    assert.equal(reserved.legacy_key, "Lena's Home"); assert.equal(reserved.visibility, 'private'); assert.equal(reserved.current_version_id, null);
    // Reuse the exact file measurements actually decoded above, binding them to
    // this isolated original package. This is automated testing, not a cloud attestation.
    const originalJob = await (await request(`/api/admin/drafts/${original.id}/review-package`, token, { method: 'POST', headers: writeHeaders })).json();
    const originalReport = await createReviewReport(originalJob, { trackId: original.manifest.track.id, versionId: original.manifest.versionId,
      decoderVersions: report.decoderVersions, valid: true, errors: [], measurements: { [Object.keys(original.manifest.assets)[0]]: report.measurements[assetId] } });
    const originalReview = await request(`/api/admin/drafts/${original.id}/attest-review`, token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ report: originalReport, policy: REVIEW_POLICY, provenanceConfirmed: true }) });
    assert.equal(originalReview.status, 201, await originalReview.clone().text());
    const originalRoute = `/api/admin/drafts/${original.id}/publication-intent`;
    const originalAction = body => request(originalRoute, token, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
    const originalPrepResponse = await originalAction({ action: 'prepare', requestId: crypto.randomUUID(),
      expectedSnapshotSha256: originalJob.snapshotSha256, expectedReportSha256: createHash('sha256').update(JSON.stringify(originalReport)).digest('hex') });
    assert.equal(originalPrepResponse.status, 201, await originalPrepResponse.clone().text());
    const originalPrep = (await originalPrepResponse.json()).preparation;
    assert.equal(originalPrep.originalImport.legacyKey, "Lena's Home");
    assert.equal((await originalAction({ action: 'check-batch', preparationId: originalPrep.id, offset: 0 })).status, 200);
    const originalIntentResponse = await originalAction({ action: 'reserve', preparationId: originalPrep.id, publicationConfirmed: true, batchWindowConfirmed: true });
    assert.equal(originalIntentResponse.status, 201, await originalIntentResponse.clone().text());
    const originalIntent = (await originalIntentResponse.json()).intent;
    for (let ordinal = 0; ordinal < 2; ordinal++) assert.equal((await originalAction({ action: 'copy-one', publicationId: originalIntent.id,
      expectedPlanSha256: originalIntent.planSha256, ordinal, publicationConfirmed: true })).status, 200);
    const originalFinalAction = body => request(`/api/admin/drafts/${original.id}/publication-final`, token, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
    const finalIdentity = { publicationId: originalIntent.id, expectedPlanSha256: originalIntent.planSha256 };
    const finalOriginalStart = await originalFinalAction({ ...finalIdentity, action: 'start', requestId: crypto.randomUUID() });
    assert.equal(finalOriginalStart.status, 201, await finalOriginalStart.clone().text());
    const originalPass = (await finalOriginalStart.json()).verification;
    assert.equal((await originalFinalAction({ ...finalIdentity, action: 'check-batch', passId: originalPass.id, offset: 0 })).status, 200);
    const originalCommit = await originalFinalAction({ ...finalIdentity, action: 'commit', passId: originalPass.id, publicationConfirmed: true, batchWindowConfirmed: true });
    assert.equal(originalCommit.status, 200, await originalCommit.clone().text());
    const originalCatalog = await (await request('/api/library/catalog', null)).json();
    assert.equal(originalCatalog.tracks["Lena's Home"].id, sourceManifest.track.id);
    assert.equal(originalCatalog.tracks["Lena's Home"].versionId, original.manifest.versionId);
    assert.equal((await publicBucket.list()).objects.length, publicCount + 2);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_tracks WHERE id = ?').bind(sourceManifest.track.id).first()).n, 1);
    // Actual Miniflare D1 batch rollback, after the first two inserts succeed.
    await db.exec("CREATE TRIGGER simulate_original_failure BEFORE INSERT ON admin_original_imports BEGIN SELECT RAISE(ABORT, 'original rollback'); END;");
    const otherSource = await read("../public/tracks/Lena's Sight/manifest.json");
    const failedImport = await request('/api/admin/original-imports', token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ requestId: crypto.randomUUID(), legacyKey: "Lena's Sight", expectedOwnerId: body.principal.id,
        sourceManifest: otherSource, importConfirmed: true }) });
    assert.equal(failedImport.status, 409);
    assert.equal(await db.prepare('SELECT id FROM library_tracks WHERE id = ?').bind(otherSource.track.id).first(), null);
    assert.equal(await db.prepare("SELECT id FROM admin_drafts WHERE original_legacy_key = ?").bind("Lena's Sight").first(), null);
  } finally { await mf.dispose(); }
});
