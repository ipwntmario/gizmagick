import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { adminClient } from '../../worker/src/admin-client.js';
import { jsonSha256 } from '../../shared/draft-review.js';

function fixture({ assetCount = 1, inspectionReply, inspectionSessionExpired = false, batchPackages = false, packageReply, packageConfirm = false,
  batchReview = false, verificationReply, verificationSessionExpired = false, intents = false, intentReply, copies = false } = {}) {
  const elements = new Map(), calls = [], downloads = [];
  let preparation = null;
  let verification = null;
  let intentPreparation = null, reservedIntent = null;
  let metadataFailure = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, files: [], disabled: false,
      textContent: '', listeners: new Map(), children: [],
      addEventListener(event, callback) { this.listeners.set(event, callback); },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      click() {}, remove() {},
    });
    return elements.get(id);
  };
  const draft = { id: '11111111-1111-4111-8111-111111111111', title: 'Private test', status: 'draft',
    missingAssets: [], uploads: [], warnings: [], review: null, manifestSha256: 'd'.repeat(64), metadataEditable: true,
    manifest: { track: { id: '22222222-2222-4222-8222-222222222222' }, versionId: '33333333-3333-4333-8333-333333333333', assets: { a: { path: 'audio/a.ogg' } } } };
  for (let i = 1; i < assetCount; i++) draft.manifest.assets[`b${String(i).padStart(3, '0')}`] = { path: `audio/file-${i}.ogg` };
  draft.uploads = Object.keys(draft.manifest.assets).map(asset_id => ({ asset_id, state: 'uploaded', byte_length: 100, sha256: 'b'.repeat(64) }));
  const report = { scope: 'administrator-review-candidate', valid: true, publishing: false, draftId: draft.id,
    versionId: draft.manifest.versionId, manifestSha256: draft.manifestSha256, jobId: '44444444-4444-4444-8444-444444444444', snapshotSha256: 'a'.repeat(64), errors: [],
    measurements: { a: { durationSeconds: 180, codec: 'opus', channels: 2, sampleRate: 48000, byteLength: 100, sha256: 'b'.repeat(64) } } };
  if (intents) { draft.review = { scope: 'administrator-attested', approvedBy: 'access:admin', approvedAt: '2026-10-13',
    reportSha256: 'b'.repeat(64), snapshotSha256: 'a'.repeat(64), serverDecoded: false, publishing: false }; draft.metadataEditable = false; }
  runInNewContext(`(${adminClient.toString()})();`, {
    document: { getElementById: id => (id.startsWith('intent-copy') && !copies) || (id.startsWith('intent-') && !intents) || (id.startsWith('verification-') && !batchReview) || id.startsWith('publication-') || (id.startsWith('package-') && !batchPackages) ? null : element(id), querySelectorAll: () => [], createElement: () => element(crypto.randomUUID()), body: { append() {} } },
    crypto, TextEncoder, File: class File {}, confirm: () => packageConfirm, Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:local-test'; }, revokeObjectURL() {} }, setTimeout: callback => callback(),
    fetch: async (path, options) => {
      calls.push({ path, options });
      let result = path === '/api/admin/drafts' && options.method === 'GET' ? { drafts: [] } : structuredClone(draft);
      if (path.endsWith('/publication-intent')) {
        const body = options.body ? JSON.parse(options.body) : {};
        if (body.action === 'prepare' && (!intentPreparation || body.restartPreparationId)) {
          intentPreparation = { id: crypto.randomUUID(), requestId: body.requestId, draftId: draft.id, trackId: draft.manifest.track.id,
            versionId: draft.manifest.versionId, manifestSha256: draft.manifestSha256, reportSha256: draft.review.reportSha256,
            snapshotSha256: draft.review.snapshotSha256, planSha256: 'f'.repeat(64), totalObjects: assetCount + 1,
            checkedObjects: 0, expiresAt: Math.floor(Date.now() / 1000) + 900, recent: true, storageCheckScope: draft.review.storageCheckScope || 'single-request' };
        }
        if (body.action === 'check-batch') {
          assert.equal(body.preparationId, intentPreparation.id); assert.equal(body.offset, intentPreparation.checkedObjects);
          intentPreparation.checkedObjects = Math.min(intentPreparation.checkedObjects + 16, assetCount + 1);
        }
        if (body.action === 'reserve') reservedIntent = { id: intentPreparation.id, draftId: draft.id, trackId: draft.manifest.track.id,
          versionId: draft.manifest.versionId, planSha256: intentPreparation.planSha256, totalObjects: assetCount + 1, state: 'pending',
          copiedObjects: 0, nextAction: copies ? 'copy-one-object' : null, continuationBlocked: !copies, storageCheckScope: draft.review.storageCheckScope || 'single-request' };
        if (body.action === 'copy-one') {
          assert.equal(body.publicationId, reservedIntent.id); assert.equal(body.expectedPlanSha256, reservedIntent.planSha256);
          assert.equal(body.ordinal, reservedIntent.copiedObjects); assert.equal(body.publicationConfirmed, true);
          reservedIntent.copiedObjects++;
          reservedIntent.nextAction = reservedIntent.copiedObjects < assetCount + 1 ? 'copy-one-object' : null;
          reservedIntent.continuationBlocked = reservedIntent.nextAction === null;
        }
        result = { workflowVersion: 2, publishing: false, publicCopyEnabled: copies, catalogCommitEnabled: false, publicationAuthorized: false,
          serverDecoded: false, pointInTimeBatches: true, preparation: reservedIntent ? null : structuredClone(intentPreparation), intent: structuredClone(reservedIntent),
          legacyPublication: null };
        if (intentReply) result = await intentReply(result, body.action || 'status');
      }
      if (/\/(review-verification|review-verification-batch|attest-review-batched)$/.test(path)) {
        const body = options.body ? JSON.parse(options.body) : {};
        if (path.endsWith('/review-verification') && options.method === 'POST') {
          if (!verification || body.restartVerificationId) verification = { id: crypto.randomUUID(), draftId: draft.id,
            trackId: draft.manifest.track.id, versionId: draft.manifest.versionId, manifestSha256: draft.manifestSha256,
            jobId: body.report.jobId, reportSha256: await jsonSha256(body.report), snapshotSha256: body.report.snapshotSha256,
            totalAssets: assetCount, checkedAssets: 0, expiresAt: Math.floor(Date.now() / 1000) + 900,
            firstCheckedAt: null, lastCheckedAt: null, state: 'pending' };
        }
        if (path.endsWith('/review-verification-batch')) {
          assert.equal(body.verificationId, verification.id); assert.equal(body.offset, verification.checkedAssets);
          verification.checkedAssets = Math.min(assetCount, verification.checkedAssets + 16);
          verification.firstCheckedAt ??= Math.floor(Date.now() / 1000); verification.lastCheckedAt = Math.floor(Date.now() / 1000);
        }
        if (path.endsWith('/attest-review-batched')) {
          verification.state = 'attested';
          draft.review = { scope: 'administrator-attested', approvedBy: 'access:admin', approvedAt: '2026-10-13',
            reportSha256: verification.reportSha256, snapshotSha256: verification.snapshotSha256, publishing: false, serverDecoded: false,
            storageCheckScope: 'bounded-batches', storageVerificationId: verification.id,
            storageCheckedFrom: verification.firstCheckedAt, storageCheckedUntil: verification.lastCheckedAt };
          draft.metadataEditable = false;
        }
        result = { verification: structuredClone(verification), review: draft.review, audioProbed: false, serverDecoded: false,
          publishing: false, publicationAuthorized: false, pointInTimeBatches: true };
        if (verificationReply) result = await verificationReply(result, path);
      }
      if (/\/review-package-(batches|batch|finish)$/.test(path)) {
        const body = options.body ? JSON.parse(options.body) : {};
        if (path.endsWith('-batches') && options.method === 'POST' && (!preparation || body.restartJobId)) {
          preparation = { jobId: crypto.randomUUID(), draftId: draft.id, trackId: draft.manifest.track.id, versionId: draft.manifest.versionId,
            manifestSha256: draft.manifestSha256, totalAssets: assetCount, checkedAssets: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600, ready: false };
        }
        if (path.endsWith('-batch')) {
          assert.equal(body.jobId, preparation.jobId); assert.equal(body.offset, preparation.checkedAssets);
          preparation.checkedAssets = Math.min(preparation.checkedAssets + 16, assetCount);
        }
        if (path.endsWith('-finish')) preparation.ready = true;
        result = { preparation: structuredClone(preparation), audioProbed: false, publishing: false, publicationAuthorized: false };
        if (path.endsWith('-finish')) {
          const snapshot = { draftId: draft.id, manifest: structuredClone(draft.manifest), assets: draft.uploads.map(asset => ({ assetId: asset.asset_id,
            path: draft.manifest.assets[asset.asset_id].path, objectKey: `drafts/${draft.id}/assets/${asset.asset_id}`, byteLength: asset.byte_length, sha256: asset.sha256, etag: 'stored' })) };
          result.package = { packageVersion: 1, policy: 'gizmagick-local-admin-v1', jobId: preparation.jobId, expiresAt: preparation.expiresAt,
            snapshot, snapshotSha256: await jsonSha256(snapshot) };
        }
        if (packageReply) result = await packageReply(result, path);
      }
      if (path.includes('/storage-inspection?')) {
        const offset = Number(new URL(path, 'https://admin.example.com').searchParams.get('offset'));
        const total = Object.keys(draft.manifest.assets).length, end = Math.min(offset + 16, total);
        result = { inspectionVersion: 1, scope: 'private-storage-batch', draftId: draft.id, trackId: draft.manifest.track.id,
          versionId: draft.manifest.versionId, manifestSha256: draft.manifestSha256, allocationSha256: 'a'.repeat(64),
          batch: { offset, end, totalAssets: total, nextOffset: end < total ? end : null },
          assets: Object.keys(draft.manifest.assets).sort().slice(offset, end).map(assetId => ({ assetId, path: draft.manifest.assets[assetId].path,
            byteLength: 100, sha256: 'b'.repeat(64), etag: 'stored-etag' })),
          checksPassed: true, batchOnly: true, pointInTimeOnly: true, audioProbed: false, publishing: false, publicationAuthorized: false };
        if (inspectionReply) result = await inspectionReply(result);
      }
      if (path.endsWith('/attest-review')) {
        draft.review = { scope: 'administrator-attested', approvedBy: 'access:admin', approvedAt: '2026-10-07', reportSha256: 'c'.repeat(64) };
        draft.metadataEditable = false;
        result = { review: draft.review };
      }
      if (path.endsWith('/metadata')) {
        if (metadataFailure) result = { error: 'Stale metadata. Copy your edits before reopening.' };
        else {
          draft.manifest = JSON.parse(options.body).manifest;
          draft.title = draft.manifest.track.title;
          draft.manifestSha256 = 'e'.repeat(64);
          result = structuredClone(draft);
        }
      }
      return { ok: !(metadataFailure && path.endsWith('/metadata')), redirected: (inspectionSessionExpired && path.includes('/storage-inspection?'))
        || (verificationSessionExpired && path.includes('/review-verification')), headers: { get: () => 'application/json' }, json: async () => result };
    },
  });
  const selectReport = async value => {
    element('review-report').files = [{ size: 2000, text: async () => JSON.stringify(value) }];
    await element('review-report').listeners.get('change')();
  };
  const openDraft = async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (batchPackages) { draft.manifestSha256 = await jsonSha256(draft.manifest); report.manifestSha256 = draft.manifestSha256; }
    element('source').value = 'manifest';
    element('manifest-file').files = [{ size: 1000, text: async () => JSON.stringify(draft.manifest) }];
    await element('create-draft').listeners.get('submit')({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { element, calls, draft, report, openDraft, selectReport, downloads, failMetadata: () => { metadataFailure = true; } };
}

async function beginClientIntent(f) {
  await f.openDraft(); await f.element('intent-refresh').listeners.get('click')(); await f.element('intent-prepare').listeners.get('click')();
}

async function reserveClientIntent(f) {
  await beginClientIntent(f);
  await f.element('intent-next').listeners.get('click')();
  f.element('intent-confirm').checked = true;
  await f.element('intent-reserve').listeners.get('click')();
}
test('bounded copy UI requires separate fresh confirmation for every exact ordinal and never commits a catalog', async () => {
  const f = fixture({ intents: true, copies: true }); await reserveClientIntent(f);
  assert.equal(f.element('intent-copy').disabled, true);
  const before = f.calls.length; await f.element('intent-copy').listeners.get('click')(); assert.equal(f.calls.length, before);
  await f.element('intent-refresh').listeners.get('click')();
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    f.element('intent-copy-confirm').checked = true; f.element('intent-copy-confirm').listeners.get('change')();
    assert.equal(f.element('intent-copy').disabled, false);
    await f.element('intent-copy').listeners.get('click')();
    const input = JSON.parse(f.calls.at(-1).options.body);
    assert.equal(input.action, 'copy-one'); assert.equal(input.ordinal, ordinal); assert.equal(input.expectedPlanSha256, 'f'.repeat(64));
    assert.equal(f.element('intent-copy-confirm').checked, false); assert.equal(f.element('intent-copy').disabled, true);
    assert.equal(f.element('intent-progress').value, ordinal + 1);
  }
  assert(f.element('intent-state').textContent.includes('Catalog continuation is locked'));
  assert.equal(f.calls.filter(call => call.options.body && JSON.parse(call.options.body).action === 'copy-one').length, 2);
});

test('lost copy response locks UI until read-only refresh; refresh recovers progress without replay', async () => {
  let fail = true;
  const f = fixture({ intents: true, copies: true, intentReply: (result, action) => {
    if (action === 'copy-one' && fail) { fail = false; throw new Error('lost public copy response'); } return result;
  } }); await reserveClientIntent(f);
  f.element('intent-copy-confirm').checked = true; await f.element('intent-copy').listeners.get('click')();
  assert.equal(f.element('intent-copy').disabled, true); assert.equal(f.element('intent-copy-confirm').checked, false);
  assert(f.element('status').textContent.includes('already have made bytes public'));
  await f.element('intent-refresh').listeners.get('click')(); assert.equal(f.calls.at(-1).options.method, 'GET');
  assert.equal(f.element('intent-progress').value, 1); assert.equal(f.element('intent-copy').disabled, true);
  await f.openDraft(); assert.equal(f.element('intent-copy').disabled, true);
  assert.equal(f.calls.filter(call => call.options.body && JSON.parse(call.options.body).action === 'copy-one').length, 1);
});

for (const mismatch of ['plan', 'progress', 'next-action', 'catalog']) test(`invalid ${mismatch} copy reply locks further public writes`, async () => {
  const f = fixture({ intents: true, copies: true, intentReply: (result, action) => {
    if (action === 'copy-one') {
      if (mismatch === 'plan') result.intent.planSha256 = 'a'.repeat(64);
      if (mismatch === 'progress') result.intent.copiedObjects = 2;
      if (mismatch === 'next-action') result.intent.nextAction = 'verify-and-commit';
      if (mismatch === 'catalog') result.catalogCommitEnabled = true;
    }
    return result;
  } }); await reserveClientIntent(f);
  f.element('intent-copy-confirm').checked = true; await f.element('intent-copy').listeners.get('click')();
  assert.equal(f.element('intent-copy').disabled, true); assert.equal(f.element('intent-copy-confirm').checked, false);
});

test('busy guard prevents duplicate public-copy clicks and status refresh clears public confirmation', async () => {
  let release;
  const f = fixture({ intents: true, copies: true, intentReply: (result, action) => action === 'copy-one'
    ? new Promise(resolve => { release = () => resolve(result); }) : result }); await reserveClientIntent(f);
  f.element('intent-copy-confirm').checked = true;
  await f.element('intent-refresh').listeners.get('click')(); assert.equal(f.element('intent-copy-confirm').checked, false);
  f.element('intent-copy-confirm').checked = true;
  const first = f.element('intent-copy').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  await f.element('intent-copy').listeners.get('click')();
  assert.equal(f.calls.filter(call => call.options.body && JSON.parse(call.options.body).action === 'copy-one').length, 1);
  release(); await first;
});
test('intent preparation is explicit and bounded, with a separate confirmation and no public-copy action', async () => {
  const f = fixture({ intents: true, assetCount: 129 }); await f.openDraft();
  const before = f.calls.length;
  await f.element('intent-prepare').listeners.get('click')(); assert.equal(f.calls.length, before);
  await f.element('intent-refresh').listeners.get('click')(); assert.equal(f.calls.at(-1).options.method, 'GET');
  await f.element('intent-prepare').listeners.get('click')();
  for (let i = 0; i < 9; i++) {
    await f.element('intent-next').listeners.get('click')();
    assert.equal(f.element('intent-progress').value, Math.min((i + 1) * 16, 130));
    assert(!f.calls.some(call => call.options.body && JSON.parse(call.options.body).action === 'reserve'));
  }
  assert.equal(f.element('intent-reserve').disabled, true);
  f.element('intent-confirm').checked = true; f.element('intent-confirm').listeners.get('change')();
  await f.element('intent-reserve').listeners.get('click')();
  const call = f.calls.find(call => call.options.body && JSON.parse(call.options.body).action === 'reserve');
  assert.equal(JSON.parse(call.options.body).publicationConfirmed, true); assert.equal(JSON.parse(call.options.body).batchWindowConfirmed, true);
  assert.equal(call.options.headers['X-Gizmagick-Admin-Request'], '1');
  assert(f.element('intent-state').textContent.includes('continuation is locked'));
  assert.equal(f.element('intent-reserve').disabled, true); assert.equal(f.element('intent-next').disabled, true);
});

test('reload recovers checks only via read-only refresh; restart needs confirmation and refresh clears reservation confirmation', async () => {
  const f = fixture({ intents: true, assetCount: 17 }); await beginClientIntent(f); await f.element('intent-next').listeners.get('click')();
  await f.openDraft(); assert.equal(f.element('intent-next').disabled, true);
  await f.element('intent-refresh').listeners.get('click')(); assert.equal(f.element('intent-progress').value, 16);
  const before = f.calls.length; await f.element('intent-restart').listeners.get('click')(); assert.equal(f.calls.length, before);
  f.element('intent-confirm').checked = true;
  await f.element('intent-refresh').listeners.get('click')(); assert.equal(f.element('intent-confirm').checked, false);
});

for (const mismatch of ['identity', 'order', 'copy-permission', 'reservation']) test(`invalid ${mismatch} intent replies cannot enable reservation or copying`, async () => {
  const f = fixture({ intents: true, intentReply: (result, action) => {
    if (mismatch === 'identity' && result.preparation) result.preparation.draftId = 'wrong';
    if (mismatch === 'order' && action === 'check-batch') result.preparation.checkedObjects = 0;
    if (mismatch === 'copy-permission') result.publicCopyEnabled = true;
    if (mismatch === 'reservation' && result.intent) result.intent.planSha256 = 'a'.repeat(64);
    return result;
  } }); await beginClientIntent(f); await f.element('intent-next').listeners.get('click')();
  f.element('intent-confirm').checked = true; await f.element('intent-reserve').listeners.get('click')();
  assert.equal(f.element('intent-reserve').disabled, true); assert.equal(f.element('intent-next').disabled, true);
  if (mismatch !== 'reservation') assert(!f.calls.some(call => call.options.body && JSON.parse(call.options.body).action === 'reserve'));
});

test('a lost reservation response is recovered by status without automatic mutation replay', async () => {
  let fail = true;
  const f = fixture({ intents: true, intentReply: (result, action) => {
    if (fail && action === 'reserve') { fail = false; throw new Error('Lost reservation response'); } return result;
  } }); await beginClientIntent(f); await f.element('intent-next').listeners.get('click')();
  f.element('intent-confirm').checked = true; await f.element('intent-reserve').listeners.get('click')();
  assert.equal(f.element('intent-reserve').disabled, true);
  await f.element('intent-refresh').listeners.get('click')();
  assert(f.element('intent-state').textContent.includes('continuation is locked'));
  assert.equal(f.calls.filter(call => call.options.body && JSON.parse(call.options.body).action === 'reserve').length, 1);
});

test('busy guard prevents duplicate readiness scans', async () => {
  let release;
  const f = fixture({ intents: true, intentReply: (result, action) => action === 'check-batch'
    ? new Promise(resolve => { release = () => resolve(result); }) : result }); await beginClientIntent(f);
  const first = f.element('intent-next').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  await f.element('intent-next').listeners.get('click')();
  assert.equal(f.calls.filter(call => call.options.body && JSON.parse(call.options.body).action === 'check-batch').length, 1);
  release(); await first;
});

async function beginClientVerification(f) {
  await f.openDraft(); await f.selectReport(f.report);
  f.element('review-confirm').checked = true; f.element('review-confirm').listeners.get('change')();
  await f.element('verification-start').listeners.get('click')();
}
test('batched review requires explicit provenance, separate manual rechecks and fresh final window confirmation', async () => {
  const f = fixture({ batchReview: true, assetCount: 129 });
  await f.openDraft(); await f.selectReport(f.report);
  assert(!f.calls.some(call => call.path.includes('/review-verification')));
  const before = f.calls.length;
  await f.element('verification-start').listeners.get('click')(); assert.equal(f.calls.length, before);
  f.element('review-confirm').checked = true;
  await f.element('verification-start').listeners.get('click')();
  assert.equal(f.element('review-confirm').checked, false);
  assert.equal(f.element('attest-review').disabled, true);
  for (let i = 0; i < 9; i++) {
    await f.element('verification-next').listeners.get('click')();
    assert.equal(f.element('verification-progress').value, Math.min((i + 1) * 16, 129));
    assert(!f.calls.some(call => call.path.endsWith('/attest-review-batched')));
  }
  assert.equal(f.element('verification-attest').disabled, true);
  f.element('review-confirm').checked = true; f.element('review-confirm').listeners.get('change')();
  f.element('verification-confirm').checked = true; f.element('verification-confirm').listeners.get('change')();
  assert.equal(f.element('verification-attest').disabled, false);
  await f.element('verification-attest').listeners.get('click')();
  const call = f.calls.find(call => call.path.endsWith('/attest-review-batched'));
  assert.equal(JSON.parse(call.options.body).batchWindowConfirmed, true); assert.equal(JSON.parse(call.options.body).provenanceConfirmed, true);
  assert.equal(call.options.headers['X-Gizmagick-Admin-Request'], '1');
  assert(f.element('review-state').textContent.includes('separate batches'));
  assert(f.element('review-state').textContent.includes('cannot be published yet'));
  assert.equal(f.element('verification-attest').disabled, true); assert.equal(f.element('metadata-editor').disabled, true);
});

test('reopening recovers only on read-only refresh and requires reselection/reconfirmation of the exact report', async () => {
  const f = fixture({ batchReview: true, assetCount: 17 }); await beginClientVerification(f);
  await f.element('verification-next').listeners.get('click')(); await f.openDraft();
  assert.equal(f.element('verification-next').disabled, true);
  await f.element('verification-refresh').listeners.get('click')();
  assert.equal(f.calls.at(-1).options.method, 'GET'); assert.equal(f.element('verification-progress').value, 16);
  await f.element('verification-next').listeners.get('click')();
  assert.equal(f.element('verification-confirm').checked, false); assert.equal(f.element('verification-attest').disabled, true);
  const other = structuredClone(f.report); other.jobId = crypto.randomUUID(); await f.selectReport(other);
  f.element('review-confirm').checked = true; f.element('verification-confirm').checked = true;
  f.element('review-confirm').listeners.get('change')(); assert.equal(f.element('verification-attest').disabled, true);
});

for (const mismatch of ['scope', 'report', 'order', 'identity', 'audit']) test(`invalid ${mismatch} verification responses lock approval`, async () => {
  const f = fixture({ batchReview: true, verificationReply: (result, path) => {
    if (mismatch === 'scope') result.serverDecoded = true;
    if (mismatch === 'report') result.verification.reportSha256 = 'e'.repeat(64);
    if (mismatch === 'identity') result.verification.draftId = 'wrong';
    if (mismatch === 'order' && path.endsWith('-batch')) result.verification.checkedAssets = 0;
    if (mismatch === 'audit' && path.endsWith('-batched')) result.review.storageCheckScope = 'single-request';
    return result;
  } }); await beginClientVerification(f);
  await f.element('verification-next').listeners.get('click')();
  f.element('review-confirm').checked = true; f.element('verification-confirm').checked = true;
  await f.element('verification-attest').listeners.get('click')();
  assert.equal(f.element('verification-attest').disabled, true);
  if (mismatch !== 'audit') assert(!f.calls.some(call => call.path.endsWith('/attest-review-batched')));
});

test('lost final response is recovered by a status read, never by automatic approval replay', async () => {
  let fail = true;
  const f = fixture({ batchReview: true, verificationReply: (result, path) => {
    if (fail && path.endsWith('/attest-review-batched')) { fail = false; throw new Error('Lost approval response'); }
    return result;
  } }); await beginClientVerification(f); await f.element('verification-next').listeners.get('click')();
  f.element('review-confirm').checked = true; f.element('verification-confirm').checked = true;
  await f.element('verification-attest').listeners.get('click')();
  assert.equal(f.element('verification-attest').disabled, true); assert.equal(f.element('verification-confirm').checked, false);
  await f.element('verification-refresh').listeners.get('click')();
  assert.equal(f.calls.filter(call => call.path.endsWith('/attest-review-batched')).length, 1);
  assert.equal(f.element('verification-next').disabled, true); assert(f.element('review-state').textContent.includes('separate batches'));
});

test('session expiry and unsaved metadata stop rechecks with no automatic retries', async () => {
  const f = fixture({ batchReview: true, verificationSessionExpired: true }); await beginClientVerification(f);
  assert.equal(f.element('verification-next').disabled, true); assert(f.element('status').textContent.includes('session may have expired'));
  const good = fixture({ batchReview: true }); await beginClientVerification(good);
  good.element('metadata-editor').value += ' '; good.element('metadata-editor').listeners.get('input')();
  assert.equal(good.element('verification-next').disabled, true); assert.equal(good.element('verification-confirm').checked, false);
});

test('busy guard prevents duplicate recheck requests', async () => {
  let release;
  const f = fixture({ batchReview: true, verificationReply: (result, path) => path.endsWith('/review-verification-batch')
    ? new Promise(resolve => { release = () => resolve(result); }) : result });
  await beginClientVerification(f);
  const first = f.element('verification-next').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('verification-next').disabled, true);
  await f.element('verification-next').listeners.get('click')();
  assert.equal(f.calls.filter(call => call.path.endsWith('/review-verification-batch')).length, 1);
  release(); await first;
});

test('batch package controls perform one guarded private action per click and download only a finished package', async () => {
  const f = fixture({ assetCount: 129, batchPackages: true }); await f.openDraft();
  assert(!f.calls.some(call => call.path.includes('/review-package-')));
  assert.equal(f.element('package-next').disabled, true);
  await f.element('package-start').listeners.get('click')();
  assert.equal(f.element('package-progress').value, 0); assert.equal(f.element('package-next').disabled, false);
  for (let i = 0; i < 9; i++) {
    await f.element('package-next').listeners.get('click')();
    assert.equal(f.element('package-progress').value, Math.min((i + 1) * 16, 129));
    assert.equal(f.downloads.length, 0);
  }
  assert(f.element('package-next').textContent.includes('Finish and download'));
  await f.element('package-next').listeners.get('click')();
  assert.equal(f.downloads.length, 1);
  assert.equal(JSON.parse(await f.downloads[0].text()).snapshot.assets.length, 129);
  assert(f.element('package-state').textContent.includes('NOT approved'));
  assert.equal(f.element('attest-review').disabled, true);
  const calls = f.calls.filter(call => call.path.includes('/review-package-'));
  assert.equal(calls.length, 11);
  assert(calls.every(call => call.options.method === 'POST' && call.options.headers['X-Gizmagick-Admin-Request'] === '1' && call.options.headers['Content-Type'] === 'application/json'));
});

test('reopening reads preparation progress only on explicit refresh, and restarting requires confirmation', async () => {
  const f = fixture({ batchPackages: true, assetCount: 17 }); await f.openDraft();
  await f.element('package-start').listeners.get('click')(); await f.element('package-next').listeners.get('click')();
  await f.openDraft(); assert.equal(f.element('package-next').disabled, true);
  const before = f.calls.length;
  await f.element('package-refresh').listeners.get('click')();
  assert.equal(f.calls.at(-1).options.method, 'GET'); assert.equal(f.element('package-progress').value, 16);
  await f.element('package-restart').listeners.get('click')(); assert.equal(f.calls.length, before + 1);
  const approved = fixture({ batchPackages: true, packageConfirm: true }); await approved.openDraft();
  await approved.element('package-start').listeners.get('click')(); await approved.element('package-next').listeners.get('click')();
  await approved.element('package-restart').listeners.get('click')();
  assert(JSON.parse(approved.calls.at(-1).options.body).restartJobId); assert.equal(approved.element('package-progress').value, 0);
});

for (const mismatch of ['identity', 'order', 'approval', 'package', 'snapshot']) test(`a ${mismatch} package response cannot advance or download`, async () => {
  const f = fixture({ batchPackages: true, packageReply: (result, path) => {
    if (mismatch === 'identity') result.preparation.draftId = 'wrong';
    if (mismatch === 'order' && path.endsWith('-batch')) result.preparation.checkedAssets = 0;
    if (mismatch === 'approval') result.publicationAuthorized = true;
    if (mismatch === 'package' && path.endsWith('-finish')) result.package.jobId = crypto.randomUUID();
    if (mismatch === 'snapshot' && path.endsWith('-finish')) result.package.snapshot.manifest.track.title = 'tampered';
    return result;
  } }); await f.openDraft();
  await f.element('package-start').listeners.get('click')();
  await f.element('package-next').listeners.get('click')(); await f.element('package-next').listeners.get('click')();
  assert.equal(f.downloads.length, 0); assert.equal(f.element('package-next').disabled, true);
  assert.equal(f.element('attest-review').disabled, true);
});

test('a lost batch reply locks continuation until status is explicitly refreshed without replaying writes', async () => {
  let fail = true;
  const f = fixture({ batchPackages: true, assetCount: 17, packageReply: (result, path) => {
    if (fail && path.endsWith('-batch')) { fail = false; throw new Error('Lost response'); }
    return result;
  } }); await f.openDraft();
  await f.element('package-start').listeners.get('click')(); await f.element('package-next').listeners.get('click')();
  assert.equal(f.element('package-next').disabled, true); assert.equal(f.downloads.length, 0);
  const before = f.calls.length; await f.element('package-next').listeners.get('click')(); assert.equal(f.calls.length, before);
  await f.element('package-refresh').listeners.get('click')(); assert.equal(f.element('package-progress').value, 16);
  assert.equal(f.calls.at(-1).options.method, 'GET');
  await f.element('package-next').listeners.get('click')(); assert.equal(JSON.parse(f.calls.at(-1).options.body).offset, 16);
});

test('busy guard prevents concurrent package steps and metadata edits clear local preparation state', async () => {
  let release;
  const f = fixture({ batchPackages: true, assetCount: 17, packageReply: (result, path) => path.endsWith('-batch')
    ? new Promise(resolve => { release = () => resolve(result); }) : result });
  await f.openDraft(); await f.element('package-start').listeners.get('click')();
  const first = f.element('package-next').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('package-next').disabled, true);
  await f.element('package-next').listeners.get('click')();
  assert.equal(f.calls.filter(call => call.path.endsWith('-batch')).length, 1);
  release(); await first;
  f.element('metadata-editor').value += ' '; f.element('metadata-editor').listeners.get('input')();
  assert.equal(f.element('package-progress').value, 0); assert.equal(f.element('package-next').disabled, true);
  const before = f.calls.length; await f.element('package-start').listeners.get('click')(); assert.equal(f.calls.length, before);
});

test('private inspection is manual, read-only, pinned between batches and reset on reopen', async () => {
  const f = fixture({ assetCount: 129 }); await f.openDraft();
  const before = f.calls.length;
  assert.equal(f.element('inspection-next').disabled, false);
  assert(!f.calls.some(call => call.path.includes('/storage-inspection')));
  for (let i = 0; i < 9; i++) {
    await f.element('inspection-next').listeners.get('click')();
    assert.equal(f.element('inspection-progress').value, Math.min((i + 1) * 16, 129));
  }
  const calls = f.calls.slice(before);
  assert.equal(calls.length, 9); assert(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'same-origin' && call.options.cache === 'no-store'));
  assert(calls.slice(1).every(call => call.path.includes('snapshot=' + 'a'.repeat(64))));
  assert.equal(f.element('inspection-next').disabled, true);
  assert(f.element('inspection-state').textContent.includes('NOT approval'));
  assert.equal(f.element('attest-review').disabled, true);
  await f.element('inspection-next').listeners.get('click')(); assert.equal(f.calls.length, before + 9);
  await f.openDraft(); assert.equal(f.element('inspection-progress').value, 0);
  assert.equal(f.element('inspection-results').textContent, '');
});

for (const mismatch of ['draft', 'manifest', 'offset', 'pin', 'asset', 'size', 'authorization', 'scope']) test(`inspection rejects a ${mismatch} response and clears earlier progress`, async () => {
  let pages = 0;
  const f = fixture({ assetCount: 17, inspectionReply: result => {
    if (++pages === 1) return result;
    if (mismatch === 'draft') result.draftId = 'wrong';
    if (mismatch === 'manifest') result.manifestSha256 = 'c'.repeat(64);
    if (mismatch === 'offset') result.batch.offset = 0;
    if (mismatch === 'pin') result.allocationSha256 = 'c'.repeat(64);
    if (mismatch === 'asset') result.assets[0].assetId = 'wrong';
    if (mismatch === 'size') result.assets[0].byteLength = 101;
    if (mismatch === 'authorization') result.publicationAuthorized = true;
    if (mismatch === 'scope') result.batchOnly = false;
    return result;
  } });
  await f.openDraft(); await f.element('inspection-next').listeners.get('click')();
  assert.equal(f.element('inspection-progress').value, 16);
  await f.element('inspection-next').listeners.get('click')();
  assert.equal(f.element('inspection-progress').value, 0); assert.equal(f.element('inspection-results').textContent, '');
  assert.equal(f.element('inspection-next').disabled, true); assert(f.element('status').textContent.includes('does not match'));
  await f.element('inspection-reset').listeners.get('click')(); assert.equal(f.element('inspection-next').disabled, false);
});

test('a malformed reply or double click cannot automatically continue a storage pass', async () => {
  let release;
  const f = fixture({ inspectionReply: () => new Promise(resolve => { release = resolve; }) });
  await f.openDraft();
  const first = f.element('inspection-next').listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('inspection-next').disabled, true);
  await f.element('inspection-next').listeners.get('click')();
  assert.equal(f.calls.filter(call => call.path.includes('/storage-inspection')).length, 1);
  release({ error: 'Session expired' }); await first;
  assert.equal(f.element('inspection-progress').value, 0); assert.equal(f.element('inspection-next').disabled, true);
});

test('an expired session stops inspection without retry or any write', async () => {
  const f = fixture({ inspectionSessionExpired: true }); await f.openDraft();
  const before = f.calls.length;
  await f.element('inspection-next').listeners.get('click')();
  assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).options.method, 'GET');
  assert(f.element('status').textContent.includes('session may have expired'));
  assert.equal(f.element('inspection-progress').value, 0); assert.equal(f.element('inspection-next').disabled, true);
});

test('unsaved edits, missing files and archival lock inspection and editing clears a pass', async () => {
  const f = fixture(); await f.openDraft(); await f.element('inspection-next').listeners.get('click')();
  f.element('metadata-editor').value += ' '; f.element('metadata-editor').listeners.get('input')();
  assert.equal(f.element('inspection-progress').value, 0); assert.equal(f.element('inspection-next').disabled, true);
  const before = f.calls.length; await f.element('inspection-next').listeners.get('click')(); assert.equal(f.calls.length, before);
  f.element('metadata-editor').value = JSON.stringify(f.draft.manifest, null, 2);
  f.draft.missingAssets = ['a']; await f.openDraft(); assert.equal(f.element('inspection-next').disabled, true);
  assert(f.element('draft-state').textContent.includes('1 missing'));
  f.draft.missingAssets = []; f.draft.status = 'archived'; await f.openDraft(); assert.equal(f.element('inspection-next').disabled, true);
  assert(f.element('draft-state').textContent.includes('archived'));
});

test('selecting a local report shows measurements but cannot automatically attest it', async () => {
  const f = fixture(); await f.openDraft();
  assert.equal(f.element('attest-review').disabled, true);
  await f.selectReport(f.report);
  assert(f.element('review-summary').textContent.includes('audio/a.ogg: 180 s'));
  assert.equal(f.element('review-confirm').checked, false);
  assert.equal(f.element('attest-review').disabled, true);
  assert(!f.calls.some(call => call.path.endsWith('/attest-review')));
});

test('explicit confirmation sends the policy through same-origin guarded API then shows persisted private attestation', async () => {
  const f = fixture(); await f.openDraft(); await f.selectReport(f.report);
  f.element('review-confirm').checked = true;
  f.element('review-confirm').listeners.get('change')();
  assert.equal(f.element('attest-review').disabled, false);
  await f.element('attest-review').listeners.get('click')();
  const call = f.calls.find(call => call.path.endsWith('/attest-review'));
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.headers['X-Gizmagick-Admin-Request'], '1');
  assert.deepEqual(JSON.parse(call.options.body), { report: f.report, policy: 'gizmagick-local-admin-v1', provenanceConfirmed: true });
  assert(f.element('review-state').textContent.includes('Administrator-attested'));
  assert(f.element('review-state').textContent.includes('NOT server-decoded'));
  assert(!f.element('review-state').textContent.includes('NOT published'));
  assert.equal(f.element('review-package').disabled, true);
  assert.equal(f.element('attest-review').disabled, true);
});

test('invalid or wrong-draft report replaces any earlier report and clears confirmation', async () => {
  const f = fixture(); await f.openDraft(); await f.selectReport(f.report);
  f.element('review-confirm').checked = true;
  await f.selectReport({ ...f.report, draftId: 'wrong-draft' });
  assert.equal(f.element('review-confirm').checked, false);
  assert.equal(f.element('attest-review').disabled, true);
  assert(f.element('status').textContent.includes('exact draft'));
  await f.element('attest-review').listeners.get('click')();
  assert(!f.calls.some(call => call.path.endsWith('/attest-review')));
});

test('editing clears selected review and prevents approval until metadata is saved', async () => {
  const f = fixture(); await f.openDraft(); await f.selectReport(f.report);
  f.element('review-confirm').checked = true;
  const edited = structuredClone(f.draft.manifest); edited.track.title = 'Edited title';
  f.element('metadata-editor').value = JSON.stringify(edited);
  f.element('metadata-editor').listeners.get('input')();
  assert.equal(f.element('review-confirm').checked, false);
  assert.equal(f.element('review-package').disabled, true);
  assert.equal(f.element('attest-review').disabled, true);
  assert.equal(f.element('save-metadata').disabled, false);
  await f.element('attest-review').listeners.get('click')();
  assert(!f.calls.some(call => call.path.endsWith('/attest-review')));
  await f.element('save-metadata').listeners.get('click')();
  const call = f.calls.find(call => call.path.endsWith('/metadata'));
  assert.equal(call.options.headers['X-Gizmagick-Admin-Request'], '1');
  assert.equal(JSON.parse(call.options.body).expectedManifestSha256, 'd'.repeat(64));
  assert.equal(f.element('draft-title').textContent, 'Edited title');
  assert.equal(f.element('save-metadata').disabled, true);
  await f.selectReport(f.report); // Same version ID, but old metadata hash.
  assert.equal(f.element('attest-review').disabled, true);
  assert(f.element('status').textContent.includes('exact draft'));
});

test('invalid JSON and a rejected stale save retain the unsaved editor text', async () => {
  const f = fixture(); await f.openDraft();
  f.element('metadata-editor').value = '{';
  await f.element('save-metadata').listeners.get('click')();
  assert.equal(f.element('metadata-editor').value, '{');
  assert(!f.calls.some(call => call.path.endsWith('/metadata')));
  const edited = structuredClone(f.draft.manifest); edited.track.title = 'Keep my edits';
  const text = JSON.stringify(edited);
  f.element('metadata-editor').value = text; f.failMetadata();
  await f.element('save-metadata').listeners.get('click')();
  assert.equal(f.element('metadata-editor').value, text);
  assert(f.element('status').textContent.includes('Copy your edits'));
});

test('attested drafts lock metadata controls and reject a synthetic save click', async () => {
  const f = fixture(); await f.openDraft(); await f.selectReport(f.report);
  f.element('review-confirm').checked = true;
  await f.element('attest-review').listeners.get('click')();
  assert.equal(f.element('metadata-editor').disabled, true);
  assert.equal(f.element('save-metadata').disabled, true);
  await f.element('save-metadata').listeners.get('click')();
  assert(!f.calls.some(call => call.path.endsWith('/metadata')));
});

test('unsaved metadata cannot be silently discarded by creating a draft or uploading audio', async () => {
  const f = fixture(); await f.openDraft();
  const text = f.element('metadata-editor').value + ' ';
  f.element('metadata-editor').value = text;
  const callCount = f.calls.length;
  await f.element('create-draft').listeners.get('submit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  await f.element('upload').listeners.get('click')();
  assert.equal(f.calls.length, callCount);
  assert.equal(f.element('metadata-editor').value, text);
});
