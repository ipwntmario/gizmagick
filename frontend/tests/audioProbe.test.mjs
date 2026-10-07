import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectOgg, oggPageCRC, AUDIO_PROBE_LIMITS } from '../scripts/lib/ogg-validation.mjs';
import { probeAudioBytes, probeManifest, createProbeReport } from '../scripts/lib/audio-probe.mjs';
import { convertLegacyTrack } from '../scripts/lib/track-manifests.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
async function legacy(name) {
  const entry = (await readJSON(path.join(publicRoot, 'trackData.json'))).tracks[name];
  const root = path.join(publicRoot, entry.basePath);
  return { root, manifest: convertLegacyTrack(name, entry,
    await readJSON(path.join(root, 'clipData.json')), await readJSON(path.join(root, 'sectionData.json'))) };
}
function page(packet, sequence, flags, granule = 0n) {
  const lengths = [];
  for (let remaining = packet.length; remaining >= 255; remaining -= 255) lengths.push(255);
  lengths.push(packet.length % 255);
  const result = new Uint8Array(27 + lengths.length + packet.length);
  result.set(Buffer.from('OggS')); result[5] = flags; result[26] = lengths.length;
  const view = new DataView(result.buffer);
  view.setBigInt64(6, granule, true); view.setUint32(14, 42, true); view.setUint32(18, sequence, true);
  result.set(lengths, 27); result.set(packet, 27 + lengths.length);
  view.setUint32(22, oggPageCRC(result), true);
  return result;
}
function opus({ audio = Uint8Array.of(0xf8, 0xff, 0xfe), granule = 960n, channels = 1 } = {}) {
  const head = new Uint8Array(19); head.set(Buffer.from('OpusHead')); head[8] = 1; head[9] = channels;
  const tags = new Uint8Array(16); tags.set(Buffer.from('OpusTags'));
  return Uint8Array.from(Buffer.concat([page(head, 0, 2), page(tags, 1, 0), page(audio, 2, 4, granule)]));
}
function mutatePage(bytes, pageIndex, mutation) {
  const result = Uint8Array.from(bytes);
  let offset = 0;
  for (let index = 0; ; index++) {
    const body = offset + 27 + result[offset + 26];
    const end = body + result.subarray(offset + 27, body).reduce((sum, size) => sum + size, 0);
    if (index === pageIndex) {
      const item = result.subarray(offset, end);
      mutation(item); new DataView(item.buffer, item.byteOffset, item.length).setUint32(22, oggPageCRC(item), true);
      break;
    }
    offset = end;
  }
  return result;
}

test('a complete 20 ms Opus silence fixture is actually decoded, not just identified', async () => {
  const bytes = opus();
  const info = inspectOgg(bytes);
  assert.deepEqual(info, { codec: 'opus', channels: 1, sampleRate: 48000, sampleCount: 960, initialOverlapSamples: 0, pages: 3 });
  const measured = await probeAudioBytes(bytes);
  assert.equal(measured.sampleCount, 960); assert.equal(measured.durationSeconds, 0.02);
  assert.equal(measured.byteLength, bytes.length); assert.match(measured.sha256, /^[a-f0-9]{64}$/);
  assert.equal(bytes[0], 79); // The caller's input was not detached/modified.
});

for (const [name, bytes, code] of [
  ['truncated header', Uint8Array.of(79), 'ogg-truncated'],
  ['truncated body', opus().subarray(0, opus().length - 1), 'ogg-truncated'],
  ['missing EOS', mutatePage(opus(), 2, item => { item[5] = 0; }), 'ogg-truncated'],
  ['trailing data', Uint8Array.from([...opus(), 0]), 'ogg-stream'],
  ['chained stream', Uint8Array.from([...opus(), ...opus()]), 'ogg-stream'],
  ['sequence gap', mutatePage(opus(), 2, item => new DataView(item.buffer, item.byteOffset).setUint32(18, 4, true)), 'ogg-sequence'],
  ['another serial', mutatePage(opus(), 2, item => new DataView(item.buffer, item.byteOffset).setUint32(14, 43, true)), 'ogg-stream'],
  ['invalid continuation', mutatePage(opus(), 2, item => { item[5] = 5; }), 'ogg-packet'],
  ['unknown flags', mutatePage(opus(), 2, item => { item[5] = 12; }), 'ogg-header'],
  ['negative granule', mutatePage(opus(), 2, item => new DataView(item.buffer, item.byteOffset).setBigInt64(6, -2n, true)), 'ogg-granule'],
  ['zero duration', opus({ granule: 0n }), 'ogg-end'],
  ['excessive duration', opus({ granule: BigInt(48000 * (AUDIO_PROBE_LIMITS.seconds + 1)) }), 'audio-duration-limit'],
  ['multichannel audio', opus({ channels: 8 }), 'audio-format-limit'],
]) test(`strict Ogg validation rejects ${name}`, () => {
  assert.throws(() => inspectOgg(bytes), error => error.code === code);
});

test('page checksum corruption fails before decoding', async () => {
  const bytes = opus(); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => inspectOgg(bytes), error => error.code === 'ogg-checksum');
  await assert.rejects(probeAudioBytes(bytes), error => error.code === 'ogg-checksum');
});

test('CRC-valid invalid codec packets fail full decoding', async () => {
  const bytes = opus({ audio: Uint8Array.of(0xff) });
  assert.equal(inspectOgg(bytes).codec, 'opus');
  await assert.rejects(probeAudioBytes(bytes), error => error.code === 'audio-decode');
});

test('a forged longer duration cannot replace decoded sample counts', async () => {
  await assert.rejects(probeAudioBytes(opus({ granule: 9600n })), error => error.code === 'audio-duration-mismatch');
});

test('invalid input, byte limits, and decoder timeouts fail closed', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array(AUDIO_PROBE_LIMITS.bytes + 1), 'audio']) {
    assert.throws(() => probeAudioBytes(bytes), error => error.code === 'audio-size');
  }
  assert.throws(() => probeAudioBytes(opus(), { timeoutMs: 0 }), error => error.code === 'audio-timeout-limit');
  await assert.rejects(probeAudioBytes(opus(), { timeoutMs: 1 }), error => error.code === 'audio-timeout');
});

test('real Lena’s Home audio has a measured duration and source-matching fingerprint', async () => {
  const { root, manifest } = await legacy("Lena's Home");
  const before = JSON.stringify(manifest);
  const result = await probeManifest(manifest, root);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const measured = Object.values(result.measurements)[0];
  assert.equal(measured.durationSeconds, 180); assert.equal(measured.sampleCount, 8640000);
  assert.equal(measured.byteLength, 3961537);
  assert.equal(measured.sha256, '954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b');
  assert.equal(JSON.stringify(manifest), before);
  const report = createProbeReport(manifest, result);
  assert.equal(report.scope, 'local-only'); assert.equal(report.publishing, false);
  assert.equal(report.trackId, manifest.track.id); assert.equal(report.versionId, manifest.versionId);
  assert.equal(report.manifestSha256.length, 64);
  const dependencies = (await readJSON(path.join(publicRoot, '../package.json'))).devDependencies;
  assert.equal(dependencies['@wasm-audio-decoders/ogg-vorbis'], report.decoderVersions.vorbis);
  assert.equal(dependencies['ogg-opus-decoder'], report.decoderVersions.opus);
});

test('real Vorbis audio is decoded with its native sample rate', async () => {
  const bytes = new Uint8Array(await readFile(path.join(publicRoot, 'tracks/BleepBloop/audio/End.ogg')));
  const info = inspectOgg(bytes), result = await probeAudioBytes(bytes);
  assert.equal(result.codec, 'vorbis'); assert.equal(result.sampleRate, info.sampleRate);
  assert.equal(result.containerSampleCount, info.sampleCount);
  assert.equal(result.sampleCount + result.initialOverlapSamples, info.sampleCount);
  assert.equal(result.initialOverlapSamples, 128); assert(result.durationSeconds > 0);
});

test('measured audio catches clip ends beyond actual duration and stale fingerprints/durations', async () => {
  const { root, manifest } = await legacy("Lena's Home");
  const clip = Object.values(manifest.clips)[0], asset = Object.values(manifest.assets)[0];
  clip.clipEnd = 181;
  let result = await probeManifest(manifest, root);
  assert.equal(result.valid, false); assert(result.errors.some(error => error.code === 'past-audio-end'));
  assert.equal(result.enrichedManifest, null);
  clip.clipEnd = 180;
  asset.sha256 = 'a'.repeat(64);
  result = await probeManifest(manifest, root);
  assert(result.errors.some(error => error.code === 'audio-fingerprint'));
  delete asset.sha256; asset.durationSeconds = 200;
  result = await probeManifest(manifest, root);
  assert(result.errors.some(error => error.code === 'audio-duration-mismatch'));
});

test('all dynamic Testing Time variants satisfy measured clip boundaries', async () => {
  const { root, manifest } = await legacy('Testing Time');
  const result = await probeManifest(manifest, root);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(Object.keys(result.measurements).length, Object.keys(manifest.assets).length);
});

test('the existing UglyOnPurpose test track exposes its real out-of-bounds clip without rewriting it', async () => {
  const { root, manifest } = await legacy('BleepBloop UglyOnPurpose');
  const original = JSON.stringify(manifest);
  const result = await probeManifest(manifest, root);
  assert.equal(result.valid, false); assert.equal(result.enrichedManifest, null);
  assert(result.errors.some(error => error.path === '/clips/Main_a/clipEnd' && error.code === 'past-audio-end'));
  assert.equal(JSON.stringify(manifest), original);
});

test('missing files and invalid manifests produce reports without enriched output', async () => {
  const { manifest } = await legacy("Lena's Home");
  const result = await probeManifest(manifest, tmpdir());
  assert.equal(result.valid, false); assert.equal(result.enrichedManifest, null);
  assert.equal(result.errors[0].code, 'ENOENT');
  assert.equal((await probeManifest({}, tmpdir())).valid, false);
  manifest.track.title = 'x'.repeat(262145);
  assert.equal((await probeManifest(manifest, tmpdir())).errors[0].code, 'audio-manifest-limit');
});

test('resolved audio links cannot escape the selected track root', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gizmagick-probe-path-'));
  try {
    const root = path.join(directory, 'track');
    await mkdir(root, { recursive: true });
    await mkdir(path.join(directory, 'outside'));
    await writeFile(path.join(directory, 'outside/silence.ogg'), opus());
    // Directory junctions do not require Windows developer-mode symlink access.
    await symlink(path.join(directory, 'outside'), path.join(root, 'audio'), process.platform === 'win32' ? 'junction' : 'dir');
    const { manifest } = await legacy("Lena's Home");
    Object.values(manifest.assets)[0].path = 'audio/silence.ogg';
    const result = await probeManifest(manifest, root);
    assert.equal(result.errors[0].code, 'audio-path');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI emits a local JSON report and returns failure for unknown options', async () => {
  const cli = fileURLToPath(new URL('../scripts/gizmagick-audio-probe.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--track', "Lena's Home"]);
  const report = JSON.parse(stdout);
  assert.equal(report.valid, true); assert.equal(report.scope, 'local-only');
  await assert.rejects(promisify(execFile)(process.execPath, [cli, '--publish']), error => error.code === 1);
  // Parent-only flags such as --input-type must not reach a file-backed worker.
  const libraryURL = new URL('../scripts/lib/audio-probe.mjs', import.meta.url).href;
  const audioPath = path.join(publicRoot, "tracks/Lena's Home/audio/Lena's Home.ogg");
  const script = `import {readFile} from 'node:fs/promises'; import {probeAudioBytes} from ${JSON.stringify(libraryURL)}; console.log(JSON.stringify(await probeAudioBytes(new Uint8Array(await readFile(${JSON.stringify(audioPath)})))));`;
  const embedded = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(JSON.parse(embedded.stdout).durationSeconds, 180);
});
