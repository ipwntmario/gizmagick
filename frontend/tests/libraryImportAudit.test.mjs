import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditOriginalLibrary, formatLibraryAudit } from '../scripts/lib/library-import-audit.mjs';
import { convertLegacyTrack, fingerprintManifest } from '../scripts/lib/track-manifests.mjs';

const ownerId = `access:${'a'.repeat(64)}`;
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/gizmagick-library-audit.mjs', import.meta.url));

// Synthetic orchestration fixtures, NOT proof of audio decoding or cloud safety.
const fakeDecode = async manifest => ({ valid: true, errors: [], warnings: [],
  measurements: Object.fromEntries(Object.entries(manifest.assets).map(([id, asset]) => [id, {
    byteLength: asset.byteLength, sha256: asset.sha256, durationSeconds: 1,
  }])), enrichedManifest: null });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gizmagick-import-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trackRoot = path.join(root, 'tracks', 'Original');
  await mkdir(path.join(trackRoot, 'audio'), { recursive: true });
  const entry = { basePath: '/tracks/Original', firstSection: 'Home', simple: true, test: true };
  const clips = { clips: { Home: { file: 'home.ogg', loopPoint: 0.5, clipEnd: 1, nextClip: ['Home'] } } };
  const sections = { sections: { Home: { firstClip: 'Home', nextSection: [], type: '' } } };
  const catalog = { tracks: { Original: entry } };
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2));
  await json(path.join(root, 'trackData.json'), catalog);
  await json(path.join(trackRoot, 'clipData.json'), clips);
  await json(path.join(trackRoot, 'sectionData.json'), sections);
  await writeFile(path.join(trackRoot, 'audio', 'home.ogg'), 'synthetic audio bytes');
  const manifest = await fingerprintManifest(convertLegacyTrack('Original', entry, clips, sections), trackRoot);
  await json(path.join(trackRoot, 'manifest.json'), manifest);
  return { root, trackRoot, catalog, clips, manifest, json };
}

async function contents(root) {
  const files = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [file, bytes] of Object.entries(await contents(path.join(root, entry.name)))) files[`${entry.name}/${file}`] = bytes;
    } else files[entry.name] = (await readFile(path.join(root, entry.name))).toString('hex');
  }
  return files;
}

test('audit preserves original identity, reports source totals and only proposes ownership without writes', async t => {
  const source = await fixture(t), before = await contents(source.root);
  const progress = [];
  const report = await auditOriginalLibrary({ publicRoot: source.root, ownerId, onTrack: item => progress.push(item.legacyKey) }, { decode: fakeDecode });
  assert.deepEqual(progress, ['Original']);
  assert.equal(report.publishing, false);
  assert.equal(report.importReady, false);
  assert.equal(report.remoteStateChecked, false);
  assert.deepEqual(report.ownershipProposal, { ownerId, status: 'proposed-only', grantsAccess: false });
  assert.equal(report.totals.passedTracks, 1);
  assert.equal(report.totals.assets, 1);
  assert.equal(report.totals.audioBytes, Buffer.byteLength('synthetic audio bytes'));
  assert.equal(report.tracks[0].legacyKey, 'Original');
  assert.equal(report.tracks[0].trackId, source.manifest.track.id);
  assert.equal(report.tracks[0].sourceSnapshot.versionId, source.manifest.versionId);
  assert.equal(report.tracks[0].checkedInManifestMatches, true);
  assert.equal(report.tracks[0].test, true); // Test tracks are not silently dropped.
  assert.match(formatLibraryAudit(report), /remote state NOT checked; import NOT ready/);
  assert.deepEqual(await contents(source.root), before);
});

test('missing owner is explicit; emails, tokens and the local seed placeholder are rejected', async t => {
  const { root } = await fixture(t);
  const report = await auditOriginalLibrary({ publicRoot: root }, { decode: fakeDecode });
  assert.equal(report.ownershipProposal.status, 'unassigned');
  for (const invalid of ['admin@example.com', 'gizmagick-admin-import', 'secret-token', '', `access:${'A'.repeat(64)}`]) {
    await assert.rejects(auditOriginalLibrary({ publicRoot: root, ownerId: invalid }), /opaque Access administrator ID/);
  }
});

test('checked-in drift is blocked without hiding decoder failures or rewriting either source', async t => {
  const source = await fixture(t);
  source.manifest.track.title = 'An independently edited title';
  await source.json(path.join(source.trackRoot, 'manifest.json'), source.manifest);
  const before = await contents(source.root);
  const decode = async manifest => ({ ...await fakeDecode(manifest), valid: false,
    errors: [{ path: '/clips/Home/clipEnd', code: 'audio-duration', message: 'Synthetic timing failure' }] });
  const report = await auditOriginalLibrary({ publicRoot: source.root }, { decode });
  assert.equal(report.totals.failedTracks, 1);
  assert.deepEqual(report.tracks[0].errors.map(error => error.code), ['manifest-drift', 'audio-duration']);
  assert.deepEqual(await contents(source.root), before);
});

test('a changed audio file keeps track identity but changes source version and flags stale fingerprints', async t => {
  const source = await fixture(t);
  await writeFile(path.join(source.trackRoot, 'audio/home.ogg'), 'new synthetic audio bytes');
  const report = await auditOriginalLibrary({ publicRoot: source.root }, { decode: fakeDecode });
  assert.equal(report.tracks[0].trackId, source.manifest.track.id);
  assert.notEqual(report.tracks[0].sourceSnapshot.versionId, source.manifest.versionId);
  assert(report.tracks[0].errors.some(error => error.code === 'manifest-drift'));
});

test('invalid source, missing manifest and unlisted folders are reported rather than imported', async t => {
  const source = await fixture(t);
  await rm(path.join(source.trackRoot, 'manifest.json'));
  await mkdir(path.join(source.root, 'tracks', 'Unlisted'));
  source.catalog.tracks.Broken = { basePath: '/tracks/../../outside', firstSection: 'Home', simple: true };
  await source.json(path.join(source.root, 'trackData.json'), source.catalog);
  const report = await auditOriginalLibrary({ publicRoot: source.root }, { decode: fakeDecode });
  assert.equal(report.totals.failedTracks, 2);
  assert(report.tracks[0].errors.some(error => error.code === 'manifest-file'));
  assert.match(report.tracks[1].errors[0].message, /inside its source directory/);
  assert.deepEqual(report.unlistedFolders, ['Unlisted']);
});

test('an escaped track-directory junction cannot be audited', async t => {
  const source = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gizmagick-audit-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(source.root, 'tracks', 'Escape'), process.platform === 'win32' ? 'junction' : 'dir');
  source.catalog.tracks.Escape = { basePath: '/tracks/Escape', firstSection: 'Home', simple: true };
  await source.json(path.join(source.root, 'trackData.json'), source.catalog);
  const report = await auditOriginalLibrary({ publicRoot: source.root, track: 'Escape' }, { decode: fakeDecode });
  assert.equal(report.totals.failedTracks, 1);
  assert.match(report.tracks[0].errors[0].message, /inside its source directory/);
});

test('missing files and incomplete measurements cannot pass the local audit', async t => {
  const source = await fixture(t);
  const incomplete = await auditOriginalLibrary({ publicRoot: source.root }, { decode: async () => ({ errors: [], warnings: [], measurements: {} }) });
  assert.equal(incomplete.tracks[0].localChecksPassed, false);
  assert.equal(incomplete.tracks[0].errors[0].code, 'incomplete-measurements');
  await rm(path.join(source.trackRoot, 'audio/home.ogg'));
  const missing = await auditOriginalLibrary({ publicRoot: source.root }, { decode: fakeDecode });
  assert.equal(missing.totals.failedTracks, 1);
  assert.equal(missing.tracks[0].errors[0].code, 'audio-file');
});

test('selection is explicit and unknown options cannot turn an audit into an upload/write command', async t => {
  const { root } = await fixture(t);
  await assert.rejects(auditOriginalLibrary({ publicRoot: root, track: 'Not present' }), /No matching catalog tracks/);
  for (const args of [['--write'], ['--upload'], ['--remote'], ['--output', 'file.json'], ['--track'], ['--json', '--json']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test('oversized source graphs fail before file fingerprinting or decoding', async t => {
  const source = await fixture(t);
  for (let index = 0; index < 256; index++) {
    source.clips.clips[`Extra${index}`] = { file: `extra${index}.ogg`, loopPoint: 0.5, clipEnd: 1, nextClip: [] };
  }
  await source.json(path.join(source.trackRoot, 'clipData.json'), source.clips);
  let decoded = false;
  const report = await auditOriginalLibrary({ publicRoot: source.root }, { decode: async manifest => {
    decoded = true;
    return fakeDecode(manifest);
  } });
  assert.equal(decoded, false);
  assert.equal(report.totals.failedTracks, 1);
  assert.equal(report.tracks[0].errors[0].code, 'import-limits');
  assert.equal(report.tracks[0].sourceSnapshot, null);
});

test('real original Lena’s Home audio decodes and agrees with its checked-in combined manifest', async () => {
  const file = path.join(publicRoot, "tracks/Lena's Home/manifest.json");
  const before = await readFile(file, 'utf8');
  const report = await auditOriginalLibrary({ publicRoot, track: "Lena's Home", ownerId });
  assert.equal(report.totals.catalogTracks, 13);
  assert.equal(report.totals.auditedTracks, 1);
  assert.equal(report.selection, "Lena's Home");
  assert.equal(report.totals.passedTracks, 1);
  assert.equal(report.totals.measuredAssets, 1);
  assert.equal(report.tracks[0].checkedInManifestMatches, true);
  assert.equal(Object.values(report.tracks[0].measurements)[0].durationSeconds, 180);
  assert.equal(report.importReady, false);
  assert.equal(await readFile(file, 'utf8'), before);
});
