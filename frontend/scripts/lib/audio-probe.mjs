import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from './track-manifests.mjs';
import { AUDIO_PROBE_LIMITS, AudioProbeError, rejectAudio } from './ogg-validation.mjs';

export { AUDIO_PROBE_LIMITS, AudioProbeError };
export function probeAudioBytes(bytes, { timeoutMs = AUDIO_PROBE_LIMITS.timeoutMs } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > AUDIO_PROBE_LIMITS.bytes) rejectAudio('audio-size', 'Audio must be nonempty and at most 16 MiB.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUDIO_PROBE_LIMITS.timeoutMs) rejectAudio('audio-timeout-limit', 'Invalid decoder timeout.');
  const copy = Uint8Array.from(bytes);
  const worker = new Worker(new URL('../gizmagick-audio-worker.mjs', import.meta.url), {
    workerData: { bytes: copy }, transferList: [copy.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    stdout: true, stderr: true, execArgv: [],
  });
  // Decoder diagnostics must not corrupt the caller's JSON report or retain
  // unbounded logging output. Validation failures use the structured channel.
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = async (error, result) => {
      if (complete) return;
      complete = true; clearTimeout(timer);
      // Await termination even on success; a timed-out decoder must not keep
      // consuming CPU in the background after its caller has failed.
      try { await worker.terminate(); }
      catch { error = new AudioProbeError('audio-worker', 'Audio validation worker could not be stopped cleanly.'); }
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new AudioProbeError('audio-timeout', 'Audio validation exceeded its processing budget.')), timeoutMs);
    worker.on('message', message => finish(message.error ? new AudioProbeError(message.error.code, message.error.message) : null, message.result));
    worker.on('error', () => finish(new AudioProbeError('audio-worker', 'Audio validation worker failed.')));
    worker.on('exit', () => { if (!complete) finish(new AudioProbeError('audio-worker', 'Audio validation worker exited before completing.')); });
  });
}

export async function readProbeFile(file, maximum, kind = 'Audio') {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > maximum) rejectAudio('audio-size', `${kind} must be a nonempty regular file of at most ${maximum} bytes.`);
    const bytes = new Uint8Array(info.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) rejectAudio('audio-changed', 'Audio changed while it was being read. Retry with a stable file.');
      position += bytesRead;
    }
    const extra = await handle.read(new Uint8Array(1), 0, 1, position);
    if (extra.bytesRead) rejectAudio('audio-changed', 'Audio grew while it was being read. Retry with a stable file.');
    return bytes;
  } finally { await handle.close(); }
}

async function readAudio(trackRoot, relative) {
  const root = await realpath(trackRoot), file = await realpath(path.join(root, relative));
  const within = path.relative(root, file);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) rejectAudio('audio-path', 'Resolved audio file escapes the track directory.');
  return readProbeFile(file, AUDIO_PROBE_LIMITS.bytes);
}

export async function probeManifest(manifest, trackRoot) {
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > 262144
      || Object.keys(manifest?.assets || {}).length > 256
      || Object.keys(manifest?.clips || {}).length > 2048
      || Object.keys(manifest?.sections || {}).length > 128) {
    return { valid: false, errors: [{ path: '/', code: 'audio-manifest-limit', message: 'Metadata exceeds the private-draft graph/size limits.' }],
      warnings: [], measurements: {}, enrichedManifest: null };
  }
  const initial = validateManifest(manifest);
  if (!initial.valid) return { valid: false, errors: initial.errors, warnings: initial.warnings, measurements: {}, enrichedManifest: null };
  const enriched = structuredClone(manifest), measurements = {}, errors = [];
  let totalBytes = 0;
  const started = performance.now();
  // Sequential decoding bounds resource use to one active decoder per run.
  for (const [id, asset] of Object.entries(manifest.assets)) {
    try {
      const bytes = await readAudio(trackRoot, asset.path);
      totalBytes += bytes.length;
      if (totalBytes > 268435456) rejectAudio('audio-total-limit', 'Track audio exceeds the 256 MiB draft limit.');
      const remaining = Math.floor(AUDIO_PROBE_LIMITS.trackTimeoutMs - (performance.now() - started));
      if (remaining < 1) rejectAudio('audio-track-timeout', 'Track validation exceeded its two-minute processing budget.');
      const measured = await probeAudioBytes(bytes, { timeoutMs: Math.min(remaining, AUDIO_PROBE_LIMITS.timeoutMs) });
      measurements[id] = measured;
      if ((asset.byteLength !== undefined && asset.byteLength !== measured.byteLength)
          || (asset.sha256 !== undefined && asset.sha256 !== measured.sha256)) rejectAudio('audio-fingerprint', 'Audio bytes do not match the supplied manifest fingerprint.');
      if (asset.durationSeconds !== undefined && Math.abs(asset.durationSeconds - measured.durationSeconds) > 0.05) rejectAudio('audio-duration-mismatch', 'Supplied duration differs from decoded duration by more than 50 ms.');
      Object.assign(enriched.assets[id], { durationSeconds: measured.durationSeconds, byteLength: measured.byteLength, sha256: measured.sha256 });
    } catch (error) {
      errors.push({ path: `/assets/${id.replaceAll('~', '~0').replaceAll('/', '~1')}`, code: error.code || 'audio-file',
        message: error instanceof AudioProbeError ? error.message : 'Audio file could not be read.' });
      if (totalBytes > 268435456 || performance.now() - started >= AUDIO_PROBE_LIMITS.trackTimeoutMs) break;
    }
  }
  const measuredValidation = errors.length ? initial : validateManifest(enriched);
  errors.push(...(errors.length ? [] : measuredValidation.errors));
  return { valid: !errors.length, errors, warnings: measuredValidation.warnings, measurements,
    enrichedManifest: errors.length ? null : enriched };
}

export function createProbeReport(manifest, result) {
  return { reportVersion: 1, scope: 'local-only', publishing: false,
    trackId: manifest.track?.id, versionId: manifest.versionId,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    decoderVersions: { vorbis: '0.1.20', opus: '1.7.5' }, limits: AUDIO_PROBE_LIMITS, ...result };
}
