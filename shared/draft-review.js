// A report is a human-review candidate, never proof that a decoder ran.
// Keep this contract portable between the local CLI and the guarded Worker.
export const REVIEW_POLICY = 'gizmagick-local-admin-v1';
export const REVIEW_DECODERS = Object.freeze({ vorbis: '0.1.20', opus: '1.7.5' });
export const REVIEW_PACKAGE_BYTES = 524288;
export const REVIEW_REPORT_BYTES = 262144;
export const jsonSha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');

export async function createReviewReport(job, report) {
  return { reportVersion: 1, scope: 'administrator-review-candidate', publishing: false,
    jobId: job.jobId, draftId: job.snapshot.draftId, snapshotSha256: job.snapshotSha256,
    manifestSha256: await jsonSha256(job.snapshot.manifest), trackId: report.trackId, versionId: report.versionId,
    decoderVersions: report.decoderVersions, valid: report.valid, errors: report.errors, measurements: report.measurements };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const sameKeys = (a, b) => object(a) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => Object.hasOwn(a, key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export async function checkReviewReport(job, report, validate) {
  const errors = [];
  const fail = message => errors.push({ path: '/', code: 'review-report', message });
  const snapshot = job.snapshot, manifest = snapshot.manifest;
  if (!keysAre(report, ['reportVersion', 'scope', 'publishing', 'jobId', 'draftId', 'snapshotSha256', 'manifestSha256',
    'trackId', 'versionId', 'decoderVersions', 'valid', 'errors', 'measurements'])
      || report.reportVersion !== 1 || report.scope !== 'administrator-review-candidate' || report.publishing !== false
      || report.jobId !== job.jobId || report.draftId !== snapshot.draftId || report.snapshotSha256 !== job.snapshotSha256
      || report.manifestSha256 !== await jsonSha256(manifest) || report.trackId !== manifest.track.id || report.versionId !== manifest.versionId
      || report.valid !== true || !Array.isArray(report.errors) || report.errors.length
      || !keysAre(report.decoderVersions, ['opus', 'vorbis'])
      || Object.entries(REVIEW_DECODERS).some(([key, value]) => report.decoderVersions[key] !== value)
      || !sameKeys(report.measurements, manifest.assets)) {
    fail('Use a complete successful report from this exact review package and the pinned local validator.');
    return { valid: false, errors, candidate: null, warnings: [] };
  }
  const candidate = structuredClone(manifest);
  for (const [id, asset] of Object.entries(manifest.assets)) {
    const measured = report.measurements[id], stored = snapshot.assets.find(item => item.assetId === id);
    if (!stored || !keysAre(measured, ['codec', 'channels', 'sampleRate', 'sampleCount', 'containerSampleCount',
      'initialOverlapSamples', 'durationSeconds', 'byteLength', 'sha256'])
        || !['opus', 'vorbis'].includes(measured.codec) || !integer(measured.channels, 1, 2)
        || !integer(measured.sampleRate, 8000, 96000) || (measured.codec === 'opus' && measured.sampleRate !== 48000)
        || !integer(measured.sampleCount, 1, measured.sampleRate * 1800)
        || !integer(measured.containerSampleCount, measured.sampleCount, measured.sampleCount + 2048)
        || ![0, 64, 128, 256, 512, 1024, 2048].includes(measured.initialOverlapSamples)
        || (measured.codec === 'opus' && measured.initialOverlapSamples !== 0)
        || measured.containerSampleCount - measured.sampleCount !== measured.initialOverlapSamples
        || !Number.isFinite(measured.durationSeconds) || Math.abs(measured.durationSeconds - measured.sampleCount / measured.sampleRate) > 1e-9
        || measured.byteLength !== stored.byteLength || measured.sha256 !== stored.sha256
        || (asset.byteLength !== undefined && asset.byteLength !== measured.byteLength)
        || (asset.sha256 !== undefined && asset.sha256 !== measured.sha256)
        || (asset.durationSeconds !== undefined && Math.abs(asset.durationSeconds - measured.durationSeconds) > 0.05)) {
      fail(`Measurement for ${id} is incomplete, inconsistent, or does not match the private uploaded file.`);
      continue;
    }
    Object.assign(candidate.assets[id], { durationSeconds: measured.durationSeconds, byteLength: measured.byteLength, sha256: measured.sha256 });
  }
  if (errors.length) return { valid: false, errors, candidate: null, warnings: [] };
  const checked = validate(candidate);
  return { valid: checked.valid, errors: checked.errors, warnings: checked.warnings, candidate: checked.valid ? candidate : null };
}
