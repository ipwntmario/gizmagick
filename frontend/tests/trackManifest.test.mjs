import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkAudioFiles, convertLegacyTrack, fingerprintManifest, validateManifest } from '../scripts/lib/track-manifests.mjs';
import { manifestToEngineData } from '../../shared/track-manifest.js';
import { chooseNextClip } from '../src/audio/transitions.js';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const catalog = (await readJSON(path.join(publicRoot, 'trackData.json'))).tracks;
async function legacy(name) {
  const root = path.join(publicRoot, catalog[name].basePath);
  return {
    root,
    clips: await readJSON(path.join(root, 'clipData.json')),
    sections: await readJSON(path.join(root, 'sectionData.json')),
  };
}
const testing = await legacy('Testing Time');
function fixture() {
  return convertLegacyTrack('Testing Time', catalog['Testing Time'], testing.clips, testing.sections);
}

for (const [name, track] of Object.entries(catalog)) {
  test(`migration preserves playback, labels, modes and audio references: ${name}`, async () => {
    const { root, clips: oldClips, sections: oldSections } = await legacy(name);
    const manifest = convertLegacyTrack(name, track, oldClips, oldSections);
    const validation = validateManifest(manifest);
    assert.deepEqual(validation.errors, []);
    assert.deepEqual(await checkAudioFiles(manifest, root), []);
    const runtime = manifestToEngineData(manifest);
    assert.equal(manifest.track.firstSection, track.firstSection);
    assert.equal(manifest.track.simple, track.simple);
    assert.equal(manifest.track.test, track.test ?? false);
    assert.deepEqual(Object.keys(runtime.clips), Object.keys(oldClips.clips));
    assert.deepEqual(Object.keys(runtime.sections), Object.keys(oldSections.sections));
    for (const [id, clip] of Object.entries(oldClips.clips)) {
      const converted = runtime.clips[id];
      assert.deepEqual(converted.file, typeof clip.file === 'string' ? { base: clip.file } : clip.file);
      assert.equal(converted.loopStart, clip.loopStart ?? 0);
      assert.equal(converted.loopPoint, clip.loopPoint);
      assert.equal(converted.clipEnd, clip.clipEnd);
      assert.deepEqual([...converted.nextClip].sort(), [...(clip.nextClip || [])].sort());
      for (const value of [0, 0.19, 0.2, 0.4, 0.6, 0.8, 0.999999]) {
        let oldDraws = 0, newDraws = 0;
        const expected = chooseNextClip(clip.nextClip, () => { oldDraws++; return value; });
        assert.equal(chooseNextClip(converted.nextClip, () => { newDraws++; return value; }), expected);
        assert.equal(newDraws, oldDraws, `${id}: RNG draw count changed`);
      }
    }
    for (const [id, section] of Object.entries(oldSections.sections)) {
      const converted = runtime.sections[id];
      assert.equal(converted.defaultDisplayName, section.defaultDisplayName);
      assert.equal(converted.defaultButtonName, section.defaultButtonName);
      assert.equal(converted.defaultBaseModeName, section.defaultBaseModeName);
      assert.equal(converted.firstClip, section.firstClip);
      assert.equal(converted.type, section.type || '');
      assert.deepEqual(converted.modes, section.modes || []);
      const targets = Array.isArray(section.nextSection) ? section.nextSection : section.nextSection ? [section.nextSection] : [];
      assert.deepEqual(manifest.sections[id].nextSections, targets);
      if (section.type === 'auto') assert.equal(converted.nextSection, targets[0]);
    }
  });
}

test('Testing Time deduplicates physical assets and expresses 3:2 choices directly', () => {
  const manifest = fixture();
  assert.equal(Object.keys(manifest.clips).length, 162);
  assert.equal(Object.keys(manifest.sections).length, 82);
  assert.equal(Object.keys(manifest.assets).length, 129);
  assert.deepEqual(manifest.clips.PreQ_a1.transitions, [{ to: 'PreQ_a2', weight: 3 }, { to: 'PreQ_a3', weight: 2 }]);
  assert.equal(manifest.clips.PostQ1_1.assetsByMode.base, manifest.clips.PostQ2_1.assetsByMode.base);
  assert.deepEqual(validateManifest(manifest).errors, []);
});

test('conversion is repeatable, does not mutate sources, and can retain imported identity through a rename', () => {
  const before = JSON.stringify(testing);
  const original = fixture();
  assert.deepEqual(fixture(), original);
  assert.equal(JSON.stringify(testing), before);
  const renamed = convertLegacyTrack('A new title', catalog['Testing Time'], testing.clips, testing.sections, { trackId: original.track.id });
  assert.equal(renamed.track.id, original.track.id);
  const changed = structuredClone(testing.clips);
  changed.clips.PreQ_a1.nextClip.push('PreQ_a2');
  const revision = convertLegacyTrack('Testing Time', catalog['Testing Time'], changed, testing.sections);
  assert.equal(revision.track.id, original.track.id);
  assert.notEqual(revision.versionId, original.versionId);
});

test('validator rejects malformed shape before semantic checks and reports actionable paths', () => {
  for (const input of [null, [], {}, { schemaVersion: 3 }]) assert.equal(validateManifest(input).valid, false);
  const manifest = fixture();
  manifest.clips.Intro.loopPont = manifest.clips.Intro.loopPoint;
  manifest.clips.Intro.loopPoint = '6';
  manifest.clips.Intro.transitions[0].weight = 0.5;
  const errors = validateManifest(manifest).errors;
  assert(errors.some(error => error.code === 'schema:additionalProperties'));
  assert(errors.some(error => error.path === '/clips/Intro/loopPoint'));
  assert(errors.some(error => error.path === '/clips/Intro/transitions/0/weight'));
});

test('validator rejects broken references, invalid timing and dangerous object/file keys', () => {
  const manifest = fixture();
  manifest.track.firstSection = 'missing';
  manifest.clips.Intro.assetsByMode.base = 'missing';
  manifest.clips.Intro.transitions[0].to = 'missing';
  manifest.clips.Intro.loopStart = manifest.clips.Intro.loopPoint;
  manifest.sections.Intro.nextSections = ['missing'];
  const codes = validateManifest(manifest).errors.map(error => error.code);
  for (const code of ['missing-section', 'missing-asset', 'missing-clip', 'invalid-timing']) assert(codes.includes(code));
  for (const file of ['audio/../secret.ogg', 'https://example.com/file.ogg', 'audio/..\\secret.ogg', 'audio/file.ogg?x=1', 'audio/.hidden.ogg']) {
    const unsafe = fixture();
    Object.values(unsafe.assets)[0].path = file;
    assert.equal(validateManifest(unsafe).valid, false, file);
  }
  const unsafe = fixture();
  Object.defineProperty(unsafe.clips, '__proto__', { enumerable: true, value: unsafe.clips.Intro });
  assert.equal(validateManifest(unsafe).valid, false);
});

test('timing allows tails and exact endings but rejects clipEnd beyond measured audio', () => {
  const manifest = fixture();
  manifest.clips.Intro.loopPoint = manifest.clips.Intro.clipEnd;
  assert.equal(validateManifest(manifest).valid, true);
  manifest.assets[manifest.clips.Intro.assetsByMode.base].durationSeconds = 1;
  assert(validateManifest(manifest).errors.some(error => error.code === 'past-audio-end'));
});

test('cycles are allowed in looping sections, but ending cycles and ambiguous auto targets are rejected', () => {
  const manifest = fixture();
  assert.equal(validateManifest(manifest).valid, true);
  manifest.sections.Intro.type = 'end';
  manifest.sections.Intro.nextSections = [];
  assert(validateManifest(manifest).errors.some(error => error.code === 'nonterminating-end'));
  manifest.sections.Intro.type = 'auto';
  manifest.sections.Intro.nextSections = ['PreQ', 'Q1'];
  assert(validateManifest(manifest).errors.some(error => error.code === 'auto-target-count'));
  manifest.sections.Intro.nextSections = ['PreQ'];
  manifest.clips.Intro.transitions = [];
  assert(validateManifest(manifest).errors.some(error => error.code === 'missing-auto-boundary'));
});

test('section membership is explicit and closure is checked; unsupported modes warn and use base', () => {
  const manifest = fixture();
  manifest.sections.PreQ.clips = ['PreQ_a1'];
  assert(validateManifest(manifest).errors.some(error => error.code === 'transition-outside-section'));
  const fallback = fixture();
  fallback.sections.Intro.modes = ['intense'];
  const result = validateManifest(fallback);
  assert.equal(result.valid, true);
  assert(result.warnings.some(warning => warning.code === 'base-mode-fallback'));
});

test('duplicate targets and excessive weights fail without expanding enormous arrays', () => {
  const manifest = fixture();
  manifest.clips.Intro.transitions.push({ to: 'Intro', weight: 1 });
  assert(validateManifest(manifest).errors.some(error => error.code === 'duplicate-transition'));
  manifest.clips.Intro.transitions = Object.keys(manifest.clips).slice(0, 5).map(to => ({ to, weight: 1024 }));
  assert(validateManifest(manifest).errors.some(error => error.code === 'weight-limit'));
});

test('legacy converter refuses unknown fields rather than discarding future musical data', () => {
  const clips = structuredClone(testing.clips);
  clips.clips.Intro.newRule = 'important';
  assert.throws(() => convertLegacyTrack('Testing Time', catalog['Testing Time'], clips, testing.sections), /unsupported fields newRule/);
});

test('audio file checks reject missing/empty files and mismatched sizes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gizmagick-manifest-test-'));
  try {
    await mkdir(path.join(root, 'audio'));
    await writeFile(path.join(root, 'audio', 'empty.ogg'), '');
    await writeFile(path.join(root, 'audio', 'short.ogg'), 'ogg');
    const errors = await checkAudioFiles({ assets: {
      missing: { path: 'audio/missing.ogg' }, empty: { path: 'audio/empty.ogg' }, size: { path: 'audio/short.ogg', byteLength: 99 },
    } }, root);
    assert.equal(errors.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI dry run checks all catalog tracks, including Lena\'s Home', () => {
  const run = spawnSync(process.execPath, ['scripts/track-manifests.mjs', 'migrate', '--dry-run'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  assert(run.stdout.includes(`Dry run complete: ${Object.keys(catalog).length} tracks validated. No files written.`));
  assert.match(run.stdout, /PASS Lena's Home: 0 errors, 0 warnings/);
  assert(!run.stdout.includes("Lena's Home is not in trackData.json"));
});

test('documented example validates under the same contract', async () => {
  const example = await readJSON(new URL('../../docs/examples/track-manifest-v2.json', import.meta.url));
  assert.deepEqual(validateManifest(example), { valid: true, errors: [], warnings: [] });
});

test('file fingerprints change snapshot identity when audio bytes change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gizmagick-fingerprint-test-'));
  try {
    await mkdir(path.join(root, 'audio'));
    await writeFile(path.join(root, 'audio', 'Intro.ogg'), 'original');
    const manifest = fixture();
    // Minimal input for the fingerprint operation; structural validation is
    // performed before this operation in the migration command.
    manifest.assets = { intro: { path: 'audio/Intro.ogg' } };
    const first = await fingerprintManifest(manifest, root);
    assert.deepEqual(await fingerprintManifest(manifest, root), first);
    assert.equal(first.assets.intro.byteLength, 8);
    assert.match(first.assets.intro.sha256, /^[a-f0-9]{64}$/);
    await writeFile(path.join(root, 'audio', 'Intro.ogg'), 'modified');
    const second = await fingerprintManifest(manifest, root);
    assert.equal(first.track.id, second.track.id);
    assert.notEqual(first.versionId, second.versionId);
    assert.equal((await checkAudioFiles(first, root))[0].code, 'audio-file');
    assert.deepEqual(await checkAudioFiles(second, root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI exports valid standalone manifests, is repeatable, and refuses to overwrite different content', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'gizmagick-export-test-'));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const args = ['scripts/track-manifests.mjs', 'migrate', '--track', 'Testing Time', '--write', '--output', output];
  const run = () => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const fingerprint = await fingerprintManifest(fixture(), testing.root);
    const file = path.join(output, fingerprint.track.id, fingerprint.versionId, 'manifest.json');
    const original = await readFile(file, 'utf8');
    assert.deepEqual(validateManifest(JSON.parse(original)).errors, []);
    assert.deepEqual(await checkAudioFiles(JSON.parse(original), testing.root), []);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(file, 'utf8'), original);
    await writeFile(file, 'preserve this edit');
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Existing export differs/);
    assert.equal(await readFile(file, 'utf8'), 'preserve this edit');
  } finally { await rm(output, { recursive: true, force: true }); }
});
