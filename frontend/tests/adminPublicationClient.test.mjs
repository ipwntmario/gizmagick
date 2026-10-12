import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { adminPage } from '../../worker/src/admin-page.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ enabled = true, reviewed = true, archived = false, assetCount = 1, savedPublication = null } = {}) {
  const html = adminPage({ principal: { id: 'access:admin', email: 'test@example.invalid' }, nonce: 'test',
    uploads: true, reviews: true, metadata: true, publishing: enabled });
  const makeElement = () => ({ value: '', checked: false, disabled: false, textContent: '', files: [], children: [], listeners: new Map(),
    addEventListener(event, callback) { this.listeners.set(event, callback); },
    replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); } });
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], makeElement()]));
  const element = id => elements.get(id) || null;
  const calls = [], failures = new Map();
  let publication = savedPublication, gate = null, alterPreview = value => value, alterStatus = value => value;
  const draft = { id: crypto.randomUUID(), title: 'Local <track> & test', status: archived ? 'archived' : 'draft',
    manifestSha256: 'd'.repeat(64), missingAssets: [], uploads: [], warnings: [], metadataEditable: !reviewed && !archived,
    manifest: { track: { id: crypto.randomUUID() }, versionId: crypto.randomUUID(),
      assets: Object.fromEntries(Array.from({ length: assetCount }, (_, i) => [`asset${i}`, { path: `audio/a${i}.ogg` }])) },
    review: reviewed ? { approvedBy: 'access:admin', approvedAt: '2026-10-12', snapshotSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64) } : null };
  const freshPublication = () => ({ id: crypto.randomUUID(), draftId: draft.id, trackId: draft.manifest.track.id,
    versionId: draft.manifest.versionId, state: 'pending', copiedObjects: 0, totalObjects: assetCount + 1,
    nextAction: 'copy-one-object', publishedAt: null });
  const reply = data => ({ ok: true, redirected: false, headers: { get: () => 'application/json' }, json: async () => structuredClone(data) });
  const writes = () => calls.filter(call => call.options.method === 'POST');
  runInNewContext(html.match(/<script nonce="test">([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: element, querySelectorAll: () => [...elements.values()], createElement: makeElement },
    crypto, TextEncoder, File: class File {}, confirm: () => false,
    fetch: async (path, options) => {
      calls.push({ path, options });
      const key = `${options.method} ${path.split('/').at(-1)}`;
      const failure = failures.get(key); failures.delete(key);
      if (gate && options.method === 'POST') { const wait = gate; gate = null; await wait; }
      if (failure === 'before') throw new Error('Network interrupted');
      if (failure === 'session') return { redirected: true };
      if (failure === 'reject') return { ...reply({ error: 'Another step is running; lease expires in two minutes.' }), ok: false };
      let data;
      if (path === '/api/admin/drafts') data = { drafts: [{ id: draft.id, title: draft.title, status: draft.status }] };
      else if (path.endsWith('/publication-preview')) data = { checksPassed: true, draftId: draft.id, trackId: draft.manifest.track.id,
        versionId: draft.manifest.versionId, review: draft.review,
        objects: [{ kind: 'audio', key: 'tracks/test/audio/a.ogg', byteLength: 42, sha256: 'c'.repeat(64) }], warnings: [] };
      else if (path.endsWith('/publication') || path.endsWith('/publication-step')) {
        if (options.method === 'POST') {
          if (path.endsWith('/publication')) publication ||= freshPublication();
          else if (publication.copiedObjects < publication.totalObjects) {
            publication.copiedObjects++;
            if (publication.copiedObjects === publication.totalObjects) publication.nextAction = 'verify-and-commit';
          } else { publication.state = 'published'; publication.nextAction = null; publication.publishedAt = '2026-10-12T12:00:00Z'; }
        }
        data = { publication, limits: { assets: 16 } };
      } else data = draft;
      if (path.endsWith('/publication-preview')) data = alterPreview(data);
      if (path.endsWith('/publication') || path.endsWith('/publication-step')) data = alterStatus(structuredClone(data));
      if (failure === 'after') throw new Error('Response lost after server write');
      return reply(data);
    },
  });
  const click = async id => { await element(id).listeners.get('click')(); await tick(); };
  const open = async () => { await tick(); await element('draft-list').children[0].children[0].listeners.get('click')(); };
  const confirmPublication = () => { element('publication-confirm').checked = true; element('publication-confirm').listeners.get('change')(); };
  const ready = async () => { await open(); await click('publication-check'); };
  const start = async () => { await ready(); confirmPublication(); await click('publication-action'); };
  return { html, element, calls, draft, open, click, ready, start, confirmPublication, writes,
    fail: (key, failure) => failures.set(key, failure), get publication() { return publication; },
    seed: values => { publication = { ...freshPublication(), ...values }; },
    alterPreview: callback => { alterPreview = callback; }, alterStatus: callback => { alterStatus = callback; },
    block: promise => { gate = promise; } };
}

test('opening, readiness and checking the exposure box never publish or copy', async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.writes().length, 0);
  assert.equal(f.element('publication-action').disabled, true);
  assert.equal(f.element('publication-confirm').checked, false);
  assert(f.element('publication-identity').textContent.includes('Local <track> & test'));
  assert(f.element('publication-preview').textContent.includes('tracks/test/audio/a.ogg'));
  f.confirmPublication();
  assert.equal(f.element('publication-action').disabled, false);
  assert.equal(f.writes().length, 0);
});

test('intent, individual copies and final catalog publication each require fresh confirmation', async () => {
  const f = fixture(); await f.ready();
  await f.click('publication-action'); assert.equal(f.writes().length, 0);
  f.confirmPublication(); await f.click('publication-action');
  assert.equal(f.publication.copiedObjects, 0);
  const start = f.writes()[0];
  assert.equal(start.options.credentials, 'same-origin');
  assert.equal(start.options.headers['X-Gizmagick-Admin-Request'], '1');
  assert.equal(JSON.parse(start.options.body).expectedSnapshotSha256, f.draft.review.snapshotSha256);
  assert.equal(JSON.parse(start.options.body).expectedReportSha256, f.draft.review.reportSha256);
  assert.equal(JSON.parse(start.options.body).publicationConfirmed, true);
  for (let i = 1; i <= 2; i++) {
    assert.equal(f.element('publication-confirm').checked, false);
    assert.equal(f.element('publication-action').disabled, true);
    await f.click('publication-action'); assert.equal(f.writes().length, i);
    f.confirmPublication(); await f.click('publication-action');
    assert.equal(f.publication.copiedObjects, i);
    assert.equal(f.publication.state, 'pending');
    assert.equal(f.element('publication-progress').value, i);
    assert.deepEqual(JSON.parse(f.writes().at(-1).options.body), { publicationId: f.publication.id, publicationConfirmed: true });
  }
  assert.equal(f.element('publication-action').textContent, 'Verify copies and publish to catalog');
  f.confirmPublication(); await f.click('publication-action');
  assert.equal(f.publication.state, 'published');
  assert(f.element('publication-state').textContent.includes('Published to the catalog at'));
  assert.equal(f.element('publication-action').textContent, 'Already published');
  assert.equal(f.element('publication-confirm').disabled, true);
  assert(!f.element('draft-state').textContent.includes('NOT published'));
  assert(!f.element('review-state').textContent.includes('NOT published'));
  f.confirmPublication(); await f.click('publication-action'); assert.equal(f.writes().length, 4);
});

test('reopening a partial intent reads recorded progress without preflight or automatic writes', async () => {
  const f = fixture(); f.seed({ copiedObjects: 1 }); await f.open();
  assert.equal(f.writes().length, 0);
  assert.equal(f.element('publication-progress').value, 1);
  assert.equal(f.element('publication-check').disabled, true);
  assert.equal(f.element('publication-action').disabled, true);
  f.confirmPublication(); await f.click('publication-action');
  assert.equal(f.writes().length, 1);
  assert(f.writes()[0].path.endsWith('/publication-step'));
  assert(!f.calls.some(call => call.path.endsWith('/publication-preview')));
});

for (const failure of ['before', 'after', 'session', 'reject']) test(`${failure} start response requires status refresh and renewed human confirmation`, async () => {
  const f = fixture(); await f.ready(); f.fail('POST publication', failure);
  f.confirmPublication(); await f.click('publication-action');
  assert.equal(f.element('publication-confirm').checked, false);
  assert.equal(f.element('publication-confirm').disabled, true);
  assert(f.element('status').textContent.includes('No automatic retry'));
  await f.click('publication-action'); assert.equal(f.writes().length, 1);
  await f.click('publication-refresh'); assert.equal(f.writes().length, 1);
  assert.equal(f.element('publication-confirm').checked, false);
  if (failure === 'after') {
    assert.equal(f.element('publication-check').disabled, true);
    f.confirmPublication(); await f.click('publication-action');
    assert(f.writes()[1].path.endsWith('/publication-step'));
  } else {
    await f.click('publication-check'); f.confirmPublication(); await f.click('publication-action');
    assert.equal(JSON.parse(f.writes()[0].options.body).requestId, JSON.parse(f.writes()[1].options.body).requestId);
  }
});

test('a lost copy response can only resume after reading progress; refreshed status clears confirmation', async () => {
  const f = fixture(); await f.start(); f.fail('POST publication-step', 'after');
  f.confirmPublication(); await f.click('publication-action');
  assert.equal(f.publication.copiedObjects, 1);
  assert.equal(f.element('publication-action').disabled, true);
  await f.click('publication-refresh');
  assert.equal(f.element('publication-progress').value, 1);
  assert.equal(f.element('publication-confirm').checked, false);
  f.confirmPublication(); await f.click('publication-refresh');
  assert.equal(f.element('publication-confirm').checked, false);
  assert.equal(f.writes().length, 2);
});

test('a failed status GET leaves every publishing write locked', async () => {
  const f = fixture(); await f.ready(); f.confirmPublication(); f.fail('GET publication', 'before');
  await f.click('publication-refresh');
  assert.equal(f.element('publication-confirm').checked, false);
  assert.equal(f.element('publication-confirm').disabled, true);
  assert.equal(f.element('publication-action').disabled, true);
  assert.equal(f.element('publication-check').disabled, true);
  await f.click('publication-action'); assert.equal(f.writes().length, 0);
});

test('busy guard prevents double-clicks from sending concurrent copy steps', async () => {
  const f = fixture(); await f.start();
  let release; f.block(new Promise(resolve => { release = resolve; }));
  f.confirmPublication(); const first = f.click('publication-action');
  await f.click('publication-action');
  assert.equal(f.writes().length, 2);
  release(); await first;
  assert.equal(f.publication.copiedObjects, 1);
});

for (const options of [{ reviewed: false }, { archived: true }, { assetCount: 17 }]) test(`ineligible draft stays locked: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); await f.open();
  assert.equal(f.element('publication-check').disabled, true);
  assert.equal(f.element('publication-action').disabled, true);
  f.confirmPublication(); await f.click('publication-action'); assert.equal(f.writes().length, 0);
});

test('archived partial publication retains exposure warning but cannot continue', async () => {
  const f = fixture({ archived: true }); f.seed({ copiedObjects: 1 }); await f.open();
  assert(f.element('publication-state').textContent.includes('Files may already be public'));
  assert(f.element('publication-state').textContent.includes('Archived: continuation is locked'));
  f.confirmPublication(); await f.click('publication-action'); assert.equal(f.writes().length, 0);
});

test('unsaved metadata invalidates readiness and prevents publication and destructive refresh', async () => {
  const f = fixture(); await f.ready(); f.confirmPublication();
  f.element('metadata-editor').value += ' ';
  f.element('metadata-editor').listeners.get('input')();
  assert.equal(f.element('publication-confirm').checked, false);
  const count = f.calls.length;
  await f.click('publication-action'); await f.click('publication-refresh');
  assert.equal(f.calls.length, count);
  assert(f.element('metadata-editor').value.endsWith(' '));
});

test('opening a different draft clears readiness, confirmation and cached request identity', async () => {
  const f = fixture(); await f.ready(); f.confirmPublication();
  f.draft.id = crypto.randomUUID(); f.draft.manifest.versionId = crypto.randomUUID();
  await f.open();
  assert.equal(f.element('publication-confirm').checked, false);
  assert.equal(f.element('publication-action').disabled, true);
  assert.equal(f.writes().length, 0);
});

test('disabled publishing renders no publishing controls or calls, retaining private-only wording', async () => {
  const f = fixture({ enabled: false }); await f.open();
  assert.equal(f.element('publication-panel'), null);
  assert(!f.html.includes('id="publication-action"'));
  assert(f.html.includes('Nothing here publishes or changes the live player'));
  assert(!f.calls.some(call => call.path.includes('/publication')));
});

test('mismatched readiness response cannot authorize an intent', async () => {
  const f = fixture(); await f.open();
  f.alterPreview(value => ({ ...value, review: { ...value.review, reportSha256: 'wrong' } }));
  await f.click('publication-check');
  assert.equal(f.element('publication-confirm').disabled, true);
  f.confirmPublication(); await f.click('publication-action'); assert.equal(f.writes().length, 0);
});

test('mismatched publication status or impossible progress keeps writes locked', async () => {
  const f = fixture(); f.seed({ copiedObjects: 1 });
  f.alterStatus(value => ({ ...value, publication: { ...value.publication, versionId: crypto.randomUUID() } }));
  await f.open(); assert.equal(f.element('publication-action').disabled, true);
  f.alterStatus(value => ({ ...value, publication: { ...value.publication, copiedObjects: 3 } }));
  await f.click('publication-refresh'); assert.equal(f.element('publication-action').disabled, true);
  f.confirmPublication(); await f.click('publication-action'); assert.equal(f.writes().length, 0);
});

test('readiness failure clears prior confirmation and does not retry automatically', async () => {
  const f = fixture(); await f.ready(); f.confirmPublication(); f.fail('GET publication-preview', 'before');
  await f.click('publication-check');
  assert.equal(f.element('publication-confirm').checked, false);
  assert.equal(f.element('publication-action').disabled, true);
  assert.equal(f.writes().length, 0);
});

test('attested publication UI also locks private audio replacement', async () => {
  const f = fixture(); await f.open();
  await f.click('upload'); assert.equal(f.writes().length, 0);
  assert(f.element('status').textContent.includes('unreviewed private drafts'));
});
