import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTrackRepository } from '../src/data/trackRepository.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { createLocalLibrarySnapshot, createManifestValidatorSource, GIZMAGICK_CATALOG_PATH } from '../scripts/lib/gizmagick-local-library.mjs';
import { validateManifest } from '../scripts/lib/track-manifests.mjs';
import { gizmagickManifestsPlugin } from '../scripts/gizmagick-manifests-plugin.mjs';
import { AudioEngine } from '../src/audio/audioEngine.js';
import { chooseNextClip } from '../src/audio/transitions.js';
import { trackDurationSeconds } from '../src/data/trackDuration.js';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const snapshot = await createLocalLibrarySnapshot(publicRoot);
const compiledSource = createManifestValidatorSource();
const { default: checkStructure } = await import(`data:text/javascript;base64,${Buffer.from(compiledSource).toString('base64')}`);
const browserValidate = manifest => validateManifestWithStructure(manifest, checkStructure);

function harness(source = 'manifest') {
  const documents = new Map(snapshot.documents);
  const calls = [];
  const failures = new Set();
  const fetchImpl = async url => {
    calls.push(url);
    if (failures.has(url)) return { ok: false, status: 503 };
    if (source === 'legacy') {
      try {
        const content = await readFile(`${publicRoot}${decodeURI(url)}`, 'utf8');
        return { ok: true, json: async () => JSON.parse(content) };
      } catch { return { ok: false, status: 404 }; }
    }
    if (!documents.has(url)) return { ok: false, status: 404 };
    return { ok: true, json: async () => JSON.parse(documents.get(url)) };
  };
  return {
    repository: createTrackRepository({ source, fetchImpl, validateManifest: browserValidate }),
    documents, failures, calls,
  };
}

test('standalone browser validation agrees with tool validation and requires no runtime compiler', () => {
  assert(!compiledSource.includes('require('));
  assert(!compiledSource.includes('new Function('));
  const entry = snapshot.catalog.tracks['Testing Time'];
  const manifest = JSON.parse(snapshot.documents.get(entry.manifestUrl));
  for (const invalid of [null, {}, [], { ...manifest, schemaVersion: 99 }, manifest]) {
    assert.deepEqual(browserValidate(invalid), validateManifest(invalid));
  }
  manifest.clips.Intro.loopPoint = 'bad';
  manifest.track.title = '🎵'.repeat(301);
  assert.deepEqual(browserValidate(manifest), validateManifest(manifest));
  manifest.track.title = 'Valid';
  manifest.clips.Intro.loopPoint = 1;
  manifest.clips.Intro.transitions[0].to = 'missing';
  assert.deepEqual(browserValidate(manifest), validateManifest(manifest));
});

test('local snapshot keeps legacy UI keys, attaches stable IDs and emits all 13 versioned documents', () => {
  assert.equal(Object.keys(snapshot.catalog.tracks).length, 13);
  assert.equal(snapshot.documents.size, 14);
  for (const [name, entry] of Object.entries(snapshot.catalog.tracks)) {
    const manifest = JSON.parse(snapshot.documents.get(entry.manifestUrl));
    assert.equal(manifest.track.id, entry.id, name);
    assert.equal(manifest.versionId, entry.versionId, name);
    assert.equal(entry.manifestUrl, `/gizmagick-tracks/${entry.id}/${entry.versionId}/manifest.json`);
    assert(entry.basePath.startsWith('/tracks/'));
    assert.deepEqual(browserValidate(manifest).errors, []);
  }
});

test('every local manifest matches legacy playback, durations, sections and audio URLs', async () => {
  const legacy = harness('legacy'), manifest = harness();
  assert.equal(legacy.calls.length + manifest.calls.length, 0);
  const catalog = await manifest.repository.loadCatalog();
  const engine = new AudioEngine();
  for (const [name, track] of Object.entries(catalog)) {
    const [old, current] = await Promise.all([legacy.repository.loadTrack(name), manifest.repository.loadTrack(name)]);
    assert.equal(current.trackId, track.id);
    assert.equal(current.versionId, track.versionId);
    assert.equal(trackDurationSeconds(track, current.clips), trackDurationSeconds(track, old.clips));
    assert.deepEqual(Object.keys(current.sections), Object.keys(old.sections));
    for (const [id, clip] of Object.entries(old.clips)) {
      const fileMap = typeof clip.file === 'string' ? { base: clip.file } : clip.file;
      for (const [mode, file] of Object.entries(fileMap)) {
        assert.equal(engine._buildAudioUrlForBase(current.clips[id].file[mode], current.basePath), engine._buildAudioUrlForBase(file, old.basePath));
      }
      for (const value of [0, 0.2, 0.5, 0.8, 0.9999]) assert.equal(chooseNextClip(current.clips[id].nextClip, () => value), chooseNextClip(clip.nextClip, () => value));
    }
    for (const [id, section] of Object.entries(old.sections)) {
      assert.equal(current.sections[id].firstClip, section.firstClip);
      assert.equal(current.sections[id].defaultDisplayName, section.defaultDisplayName);
      assert.deepEqual(current.sections[id].modes, section.modes || []);
    }
  }
  assert.equal(manifest.calls.length, 14);
  assert(manifest.calls.every(url => !url.includes('clipData') && !url.includes('sectionData') && url !== '/trackData.json'));
  assert.equal(legacy.calls.length, 27);
});

test('playback, preview and queued preparation share concurrent metadata requests and cached results', async () => {
  const { repository, calls } = harness();
  const [playback, preview, queue] = await Promise.all(Array.from({ length: 3 }, () => repository.loadTrack('Testing Time')));
  assert.strictEqual(playback, preview);
  assert.strictEqual(preview, queue);
  assert.equal(calls.length, 2);
  assert.strictEqual(await repository.loadTrack('Testing Time'), playback);
  assert.equal(calls.length, 2);
  assert.equal(playback.buffersReady, undefined, 'Decoded-buffer state belongs to App, not the shared repository');
});

test('failed catalog and manifest requests are retriable and never fall back to old metadata', async () => {
  const { repository, failures, calls } = harness();
  failures.add(GIZMAGICK_CATALOG_PATH);
  await assert.rejects(repository.loadCatalog(), /catalog \(503\)/);
  failures.clear();
  const catalog = await repository.loadCatalog();
  const entry = catalog['Testing Time'];
  failures.add(entry.manifestUrl);
  await assert.rejects(repository.loadTrack('Testing Time'), /manifest \(503\)/);
  failures.clear();
  assert.equal((await repository.loadTrack('Testing Time')).trackId, entry.id);
  assert.equal(calls.filter(url => url === entry.manifestUrl).length, 2);
  assert(calls.every(url => url.startsWith('/gizmagick-tracks/')));
});

test('malformed manifests, bad references and mismatched versions fail before reaching the engine', async () => {
  for (const mutation of [
    manifest => { manifest.schemaVersion = 7; },
    manifest => { manifest.versionId = '44444444-4444-4444-8444-444444444444'; },
    manifest => { manifest.track.title = 'Wrong title'; },
    manifest => { manifest.clips.Intro.transitions[0].to = 'missing'; },
  ]) {
    const { repository, documents } = harness();
    const entry = snapshot.catalog.tracks['Testing Time'];
    const manifest = JSON.parse(documents.get(entry.manifestUrl));
    mutation(manifest);
    documents.set(entry.manifestUrl, JSON.stringify(manifest));
    await assert.rejects(repository.loadTrack('Testing Time'), /Invalid Testing Time manifest|catalog\/manifest mismatch/);
    documents.set(entry.manifestUrl, snapshot.documents.get(entry.manifestUrl));
    assert.equal((await repository.loadTrack('Testing Time')).versionId, entry.versionId);
  }
});

test('invalid JSON and unknown tracks produce clear errors without caching failures', async () => {
  const { repository, documents } = harness();
  documents.set(GIZMAGICK_CATALOG_PATH, '<html>fallback</html>');
  await assert.rejects(repository.loadCatalog(), /Invalid JSON in Gizmagick catalog/);
  documents.set(GIZMAGICK_CATALOG_PATH, snapshot.documents.get(GIZMAGICK_CATALOG_PATH));
  await assert.rejects(repository.loadTrack('missing'), /Unknown Gizmagick track: missing/);
  const entry = snapshot.catalog.tracks['Testing Time'];
  documents.set(entry.manifestUrl, 'not JSON');
  await assert.rejects(repository.loadTrack('Testing Time'), /Invalid JSON in Testing Time manifest/);
  documents.set(entry.manifestUrl, snapshot.documents.get(entry.manifestUrl));
  assert.equal((await repository.loadTrack('Testing Time')).trackId, entry.id);
});

test('catalogs reject unsupported versions and duplicate track identity', async () => {
  const { repository, documents } = harness();
  const catalog = structuredClone(snapshot.catalog);
  catalog.schemaVersion = 99;
  documents.set(GIZMAGICK_CATALOG_PATH, JSON.stringify(catalog));
  await assert.rejects(repository.loadCatalog(), /Invalid Gizmagick track catalog/);
  catalog.schemaVersion = 2;
  catalog.tracks["Lena's Home"].id = catalog.tracks['Testing Time'].id;
  documents.set(GIZMAGICK_CATALOG_PATH, JSON.stringify(catalog));
  await assert.rejects(repository.loadCatalog(), /Invalid Gizmagick manifest catalog entry/);
});

test('metadata cache distinguishes versions even when the compatibility name stays the same', async () => {
  const { repository, documents, calls } = harness();
  const old = await repository.loadTrack('Testing Time');
  const catalog = await repository.loadCatalog();
  const entry = catalog['Testing Time'];
  const manifest = JSON.parse(documents.get(entry.manifestUrl));
  manifest.versionId = '44444444-4444-4444-8444-444444444444';
  entry.versionId = manifest.versionId;
  entry.manifestUrl = `/gizmagick-tracks/${entry.id}/${entry.versionId}/manifest.json`;
  documents.set(entry.manifestUrl, JSON.stringify(manifest));
  const current = await repository.loadTrack('Testing Time');
  assert.notStrictEqual(old, current);
  assert.notEqual(old.versionId, current.versionId);
  assert.equal(calls.length, 3);
});

test('Vite emits a fresh manifest catalog for builds and serves exact JSON/404s during development', async () => {
  const plugin = gizmagickManifestsPlugin({ source: 'manifest', publicRoot });
  const emitted = [];
  plugin.configResolved({ command: 'build' });
  await plugin.buildStart.call({ emitFile: asset => emitted.push(asset) });
  assert.equal(emitted.length, 14);
  assert(emitted.some(asset => asset.fileName === 'gizmagick-tracks/catalog.json'));
  let middleware;
  await plugin.configureServer({ middlewares: { use: handler => { middleware = handler; } } });
  function request(url, method = 'GET') {
    const result = { headers: {}, statusCode: 200 };
    middleware({ url, method }, {
      setHeader: (name, value) => { result.headers[name] = value; },
      set statusCode(value) { result.statusCode = value; },
      end: value => { result.body = value; },
    }, () => { result.next = true; });
    return result;
  }
  assert.equal(JSON.parse(request(GIZMAGICK_CATALOG_PATH).body).schemaVersion, 2);
  assert.equal(request('/gizmagick-tracks/missing.json').statusCode, 404);
  assert.equal(request(GIZMAGICK_CATALOG_PATH, 'POST').statusCode, 405);
  assert.equal(request(GIZMAGICK_CATALOG_PATH, 'HEAD').body, undefined);
  assert.equal(request('/other').next, true);
  assert.equal(request(GIZMAGICK_CATALOG_PATH).headers['Cache-Control'], 'no-store');
});

test('legacy mode emits no new documents and rejects accidental unknown source settings', async () => {
  assert.throws(() => createTrackRepository({ source: 'typo' }), /Unknown Gizmagick track source/);
  assert.throws(() => createTrackRepository({ source: 'manifest' }), /validation is required/);
  assert.throws(() => gizmagickManifestsPlugin({ source: 'typo', publicRoot }), /Unknown VITE_TRACK_SOURCE/);
  const plugin = gizmagickManifestsPlugin({ source: 'legacy', publicRoot });
  assert.equal(plugin.load(plugin.resolveId('virtual:gizmagick-manifest-validator')), 'export default null;', 'Legacy rollback should not ship an unused schema validator');
  plugin.configResolved({ command: 'build' });
  await plugin.buildStart.call({ emitFile: () => assert.fail('Legacy mode should not emit manifests') });
  await plugin.configureServer({ middlewares: { use: () => assert.fail('Legacy mode should not add manifest middleware') } });
});
