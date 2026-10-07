import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { adminClient } from '../../worker/src/admin-client.js';

function fixture() {
  const elements = new Map(), calls = [];
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
    missingAssets: [], uploads: [], warnings: [], review: null,
    manifest: { track: { id: '22222222-2222-4222-8222-222222222222' }, versionId: '33333333-3333-4333-8333-333333333333', assets: { a: { path: 'audio/a.ogg' } } } };
  const report = { scope: 'administrator-review-candidate', valid: true, publishing: false, draftId: draft.id,
    versionId: draft.manifest.versionId, jobId: '44444444-4444-4444-8444-444444444444', snapshotSha256: 'a'.repeat(64), errors: [],
    measurements: { a: { durationSeconds: 180, codec: 'opus', channels: 2, sampleRate: 48000, byteLength: 100, sha256: 'b'.repeat(64) } } };
  runInNewContext(`(${adminClient.toString()})();`, {
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => element(crypto.randomUUID()) },
    crypto, TextEncoder, File: class File {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      let result = path === '/api/admin/drafts' && options.method === 'GET' ? { drafts: [] } : structuredClone(draft);
      if (path.endsWith('/attest-review')) {
        draft.review = { scope: 'administrator-attested', approvedBy: 'access:admin', approvedAt: '2026-10-07', reportSha256: 'c'.repeat(64) };
        result = { review: draft.review };
      }
      return { ok: true, redirected: false, headers: { get: () => 'application/json' }, json: async () => result };
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
  return { element, calls, draft, report, openDraft, selectReport };
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
