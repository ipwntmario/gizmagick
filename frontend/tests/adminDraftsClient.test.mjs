import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { adminClient } from '../../worker/src/admin-client.js';

function fixture() {
  const elements = new Map(), calls = [];
  let metadataFailure = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, files: [], disabled: false,
      textContent: '', listeners: new Map(), children: [],
      addEventListener(event, callback) { this.listeners.set(event, callback); },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
    });
    return elements.get(id);
  };
  const draft = { id: '11111111-1111-4111-8111-111111111111', title: 'Private test', status: 'draft',
    missingAssets: [], uploads: [], warnings: [], review: null, manifestSha256: 'd'.repeat(64), metadataEditable: true,
    manifest: { track: { id: '22222222-2222-4222-8222-222222222222' }, versionId: '33333333-3333-4333-8333-333333333333', assets: { a: { path: 'audio/a.ogg' } } } };
  const report = { scope: 'administrator-review-candidate', valid: true, publishing: false, draftId: draft.id,
    versionId: draft.manifest.versionId, manifestSha256: draft.manifestSha256, jobId: '44444444-4444-4444-8444-444444444444', snapshotSha256: 'a'.repeat(64), errors: [],
    measurements: { a: { durationSeconds: 180, codec: 'opus', channels: 2, sampleRate: 48000, byteLength: 100, sha256: 'b'.repeat(64) } } };
  runInNewContext(`(${adminClient.toString()})();`, {
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => element(crypto.randomUUID()) },
    crypto, TextEncoder, File: class File {}, confirm: () => false,
    fetch: async (path, options) => {
      calls.push({ path, options });
      let result = path === '/api/admin/drafts' && options.method === 'GET' ? { drafts: [] } : structuredClone(draft);
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
      return { ok: !(metadataFailure && path.endsWith('/metadata')), redirected: false, headers: { get: () => 'application/json' }, json: async () => result };
    },
  });
  const selectReport = async value => {
    element('review-report').files = [{ size: 2000, text: async () => JSON.stringify(value) }];
    await element('review-report').listeners.get('change')();
  };
  const openDraft = async () => {
    await new Promise(resolve => setImmediate(resolve));
    element('source').value = 'manifest';
    element('manifest-file').files = [{ size: 1000, text: async () => JSON.stringify(draft.manifest) }];
    await element('create-draft').listeners.get('submit')({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { element, calls, draft, report, openDraft, selectReport, failMetadata: () => { metadataFailure = true; } };
}

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
  assert(f.element('review-state').textContent.includes('NOT server-decoded / NOT published'));
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
