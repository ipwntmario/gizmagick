import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { calculateClipEndChanges } from '../../shared/clip-end-preparation.js';
import { prepareClipEnds } from '../scripts/lib/clip-end-preparation.mjs';
import { validateManifest } from '../scripts/lib/track-manifests.mjs';
import { probeManifest } from '../scripts/lib/audio-probe.mjs';
import { jsonSha256 } from '../../shared/draft-review.js';

const publicRoot = new URL('../public/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(`tracks/${name}/manifest.json`, publicRoot), 'utf8'));
const measured = durationSeconds => ({ durationSeconds, byteLength: 100, sha256: 'a'.repeat(64) });
// Synthetic policy fixtures, NOT decoder or administrator-attestation evidence.
function fixture(end, durations = [10]) {
  if (arguments.length === 0) end = 20;
  const manifest = { assets: {}, clips: { clip: { assetsByMode: {}, loopStart: 0, loopPoint: 9 } } }, measurements = {};
  for (const [index, seconds] of durations.entries()) {
    const id = `asset${index}`;
    manifest.assets[id] = { path: `audio/${id}.ogg` };
    manifest.clips.clip.assetsByMode[index === 0 ? 'base' : `mode${index}`] = id;
    measurements[id] = measured(seconds);
  }
  if (end !== undefined) manifest.clips.clip.clipEnd = end;
  return { manifest, measurements };
}

for (const [label, endpoint, reason] of [['missing', undefined, 'missing'], ['long', 20, 'too-long']]) {
  test(`measured ${label} clip end becomes file duration without mutating its source`, () => {
    const { manifest, measurements } = fixture(endpoint), before = JSON.stringify(manifest);
    const result = calculateClipEndChanges(manifest, measurements);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.changes, [{ clipId: 'clip', from: endpoint ?? null, to: 10, reason }]);
    assert.equal(JSON.stringify(manifest), before);
    assert.equal(manifest.clips.clip.loopPoint, 9);
  });
}

test('explicit shorter trims and exact file ends are kept, including mismatched mode lengths', () => {
  for (const [end, durations] of [[9.5, [10]], [10, [10]], [9.5, [10, 12]]]) {
    const { manifest, measurements } = fixture(end, durations);
    assert.deepEqual(calculateClipEndChanges(manifest, measurements), { changes: [], errors: [] });
  }
});

test('rounding upward to a microsecond preserves rounded end/loopPoint equality', () => {
  const { manifest, measurements } = fixture(undefined, [16.153854875283447]);
  manifest.clips.clip.loopPoint = 16.153855;
  const result = calculateClipEndChanges(manifest, measurements);
  assert.deepEqual(result.errors, []); assert.equal(result.changes[0].to, 16.153855);
  manifest.clips.clip.clipEnd = 16.153855;
  assert.equal(calculateClipEndChanges(manifest, measurements).changes.length, 0);
});

test('near-equal mode lengths use a common shortest end; larger differences require manual choice', () => {
  let input = fixture(undefined, [10, 10.05]);
  assert.equal(calculateClipEndChanges(input.manifest, input.measurements).changes[0].to, 10);
  input = fixture(undefined, [10, 10.051]);
  const result = calculateClipEndChanges(input.manifest, input.measurements);
  assert.equal(result.errors[0].code, 'preparation-mode-lengths'); assert.deepEqual(result.changes, []);
});

for (const end of [null, '', '10', -1, 0, NaN, Infinity]) test(`invalid explicit endpoint ${String(end)} is not treated as missing`, () => {
  const { manifest, measurements } = fixture(end);
  assert.equal(calculateClipEndChanges(manifest, measurements).errors[0].code, 'preparation-end');
});

test('a transition after the usable end is never silently moved', () => {
  const { manifest, measurements } = fixture(undefined);
  manifest.clips.clip.loopPoint = 10.001;
  const result = calculateClipEndChanges(manifest, measurements);
  assert.equal(result.errors[0].code, 'preparation-loop'); assert.deepEqual(result.changes, []);
});

test('missing/extra measurements, unsafe keys, stale fingerprints and ambiguous clips block the whole proposal', () => {
  let input = fixture(); input.measurements = {};
  assert(calculateClipEndChanges(input.manifest, input.measurements).errors.length);
  input = fixture(); input.measurements.extra = measured(10);
  assert(calculateClipEndChanges(input.manifest, input.measurements).errors.length);
  input = fixture(); input.manifest.assets.asset0.sha256 = 'b'.repeat(64);
  assert.equal(calculateClipEndChanges(input.manifest, input.measurements).errors[0].code, 'preparation-measurement');
  input = fixture(); input.manifest.clips.constructor = structuredClone(input.manifest.clips.clip);
  assert.deepEqual(calculateClipEndChanges(input.manifest, input.measurements).changes, []);
});

test('real UglyOnPurpose proposal fixes only Main_a and does not overwrite canonical manifests/audio', async () => {
  const name = 'BleepBloop UglyOnPurpose', source = await read(name), before = JSON.stringify(source);
  const root = fileURLToPath(new URL(`tracks/${name}/`, publicRoot));
  const report = await prepareClipEnds(source, root);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.scope, 'local-metadata-preparation'); assert.equal(report.approval, false); assert.equal(report.publishing, false);
  assert.equal(report.sourceManifestSha256, await jsonSha256(source));
  assert.deepEqual(report.changes, [{ clipId: 'Main_a', from: 16.153855, to: 13.846168, reason: 'too-long' }]);
  assert.equal(Object.keys(report.measurements).length, 6);
  assert.equal(report.manifest, undefined); assert.equal(report.enrichedManifest, undefined);
  assert.equal(JSON.stringify(source), before);
  assert.equal(JSON.stringify(await read(name)), before);
  const corrected = structuredClone(source);
  for (const change of report.changes) corrected.clips[change.clipId].clipEnd = change.to;
  assert.equal(validateManifest(corrected).valid, true);
  assert.equal((await probeManifest(corrected, root)).valid, true);
  assert.equal((await probeManifest(source, root)).valid, false); // Ordinary review still refuses the untouched original.
});

test('real missing ending is prepared but canonical schema stays strict; stale asset constraints and graph errors fail', async () => {
  const source = await read("Lena's Home"), root = fileURLToPath(new URL("tracks/Lena's Home/", publicRoot));
  const clip = Object.values(source.clips)[0]; delete clip.clipEnd;
  assert.equal(validateManifest(source).valid, false);
  const report = await prepareClipEnds(source, root);
  assert.equal(report.valid, true); assert.equal(report.changes[0].to, 180); assert.equal(report.changes[0].reason, 'missing');
  const broken = structuredClone(source); Object.values(broken.assets)[0].sha256 = '0'.repeat(64);
  assert.equal((await prepareClipEnds(broken, root)).valid, false);
  clip.transitions = [{ to: 'missing', weight: 1 }];
  const invalid = await prepareClipEnds(source, root);
  assert.equal(invalid.valid, false); assert.deepEqual(invalid.measurements, {});
});

test('preparation CLI cannot accept a review package, write sources or publish', () => {
  const cli = fileURLToPath(new URL('../scripts/gizmagick-clip-ends.mjs', import.meta.url));
  for (const args of [['--write'], ['--review-package', 'file'], ['--publish'], ['--manifest'], ['--output', 'file']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
  }
});
