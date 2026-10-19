import { createHash } from 'node:crypto';
import { calculateClipEndChanges } from '../../../shared/clip-end-preparation.js';
import { probeManifest } from './audio-probe.mjs';
import { validateManifest } from './track-manifests.mjs';

export async function prepareClipEnds(manifest, trackRoot) {
  const report = { reportVersion: 1, scope: 'local-metadata-preparation', policy: 'gizmagick-clip-ends-v1', publishing: false, approval: false,
    trackId: manifest?.track?.id, versionId: manifest?.versionId,
    sourceManifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    valid: false, errors: [], warnings: [], changes: [], measurements: {} };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 262144 || Object.keys(manifest?.assets || {}).length > 256
      || Object.keys(manifest?.clips || {}).length > 2048 || Object.keys(manifest?.sections || {}).length > 128) {
    report.errors.push({ path: '/', code: 'preparation-limit', message: 'Metadata exceeds the private-draft limits.' }); return report;
  }
  const normalized = structuredClone(manifest);
  for (const clip of Object.values(normalized?.clips || {})) {
    if (clip && typeof clip === 'object' && !Object.hasOwn(clip, 'clipEnd')) clip.clipEnd = clip.loopPoint;
  }
  const checked = validateManifest(normalized);
  // Only missing endpoints (filled above) and past-end values are repairable.
  // Reject malformed fields, references, graphs and other timing errors first.
  report.errors = checked.errors.filter(error => error.code !== 'past-audio-end');
  report.warnings = checked.warnings;
  if (report.errors.length) return report;
  const probeInput = structuredClone(normalized);
  // This private measurement clone uses the shortest authored playback span.
  // Never save it or use it as the review package: actual proposals below are
  // recomputed from the untouched input, preserving all intentional trims.
  for (const clip of Object.values(probeInput.clips)) clip.clipEnd = clip.loopPoint;
  const measured = await probeManifest(probeInput, trackRoot);
  report.measurements = measured.measurements;
  if (!measured.valid) { report.errors = measured.errors; return report; }
  const proposal = calculateClipEndChanges(manifest, measured.measurements);
  report.errors = proposal.errors;
  if (report.errors.length) return report;
  const candidate = structuredClone(manifest);
  for (const change of proposal.changes) candidate.clips[change.clipId].clipEnd = change.to;
  const measuredCandidate = structuredClone(candidate);
  for (const [id, asset] of Object.entries(measuredCandidate.assets)) asset.durationSeconds = measured.measurements[id].durationSeconds;
  const final = validateManifest(measuredCandidate);
  report.errors = final.errors; report.warnings = final.warnings;
  report.valid = final.valid;
  report.changes = final.valid ? proposal.changes : [];
  return report; // Deliberately no publishable manifest or same-version export.
}
