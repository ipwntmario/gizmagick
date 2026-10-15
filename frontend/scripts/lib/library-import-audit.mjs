import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { safeLibraryKey } from '../../../shared/library-contract.js';
import { checkAudioFiles, convertLegacyTrack, fingerprintManifest, validateManifest } from './track-manifests.mjs';
import { AUDIO_PROBE_LIMITS, probeManifest, readProbeFile } from './audio-probe.mjs';

const metadataLimit = 262144;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const issue = (code, message, at = '/') => ({ code, message, path: at });

function requireChild(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Resolved path must stay inside its source directory.');
  }
  return file;
}

async function readJSON(root, file) {
  const resolved = requireChild(root, await realpath(path.resolve(root, file)));
  return JSON.parse(Buffer.from(await readProbeFile(resolved, metadataLimit, 'Metadata')).toString('utf8'));
}

async function auditTrack(publicRoot, tracksRoot, legacyKey, entry, decode) {
  const item = {
    legacyKey, sourceBasePath: entry?.basePath ?? null, trackId: null,
    localChecksPassed: false, checkedInManifestMatches: false,
    assets: 0, clips: 0, sections: 0, audioBytes: 0, measuredAssets: 0,
    test: entry?.test ?? false, sourceSnapshot: null,
    errors: [], warnings: [], measurements: {},
  };
  try {
    if (!safeLibraryKey(legacyKey)) throw new Error('Unsafe legacy compatibility key.');
    if (typeof entry?.basePath !== 'string' || !entry.basePath.startsWith('/tracks/') || entry.basePath.includes('\\')) {
      throw new Error('Catalog basePath must be a local /tracks/ path.');
    }
    const lexicalRoot = requireChild(path.join(publicRoot, 'tracks'), path.resolve(publicRoot, `.${entry.basePath}`));
    const trackRoot = requireChild(tracksRoot, await realpath(lexicalRoot));
    const converted = convertLegacyTrack(legacyKey, entry,
      await readJSON(trackRoot, 'clipData.json'), await readJSON(trackRoot, 'sectionData.json'));
    const validation = validateManifest(converted);
    item.trackId = converted.track.id;
    item.assets = Object.keys(converted.assets).length;
    item.clips = Object.keys(converted.clips).length;
    item.sections = Object.keys(converted.sections).length;
    item.warnings = validation.warnings;
    if (!validation.valid) { item.errors.push(...validation.errors); return item; }
    if (item.assets > 256 || item.clips > 2048 || item.sections > 128
        || Buffer.byteLength(JSON.stringify(converted)) > metadataLimit) {
      item.errors.push(issue('import-limits', 'Source exceeds the current private-draft graph/metadata limits.'));
      return item;
    }
    item.errors.push(...await checkAudioFiles(converted, trackRoot));
    if (item.errors.length) return item;
    // Check size before the existing fingerprint helper reads files. This local
    // audit is not an atomic snapshot or authority for a later cloud write.
    for (const asset of Object.values(converted.assets)) {
      const file = requireChild(trackRoot, await realpath(path.join(trackRoot, asset.path)));
      const size = (await stat(file)).size;
      if (size > AUDIO_PROBE_LIMITS.bytes) throw new Error(`${asset.path} exceeds the 16 MiB audio-file limit.`);
      item.audioBytes += size;
    }
    if (item.audioBytes > 268435456) throw new Error('Track audio exceeds the 256 MiB private-draft limit.');
    const snapshot = await fingerprintManifest(converted, trackRoot);
    const snapshotText = JSON.stringify(snapshot);
    if (Buffer.byteLength(snapshotText) > metadataLimit) throw new Error('Fingerprinted manifest exceeds the metadata limit.');
    item.sourceSnapshot = {
      versionId: snapshot.versionId, manifestSha256: sha256(snapshotText),
      manifestBytes: Buffer.byteLength(snapshotText),
    };
    try {
      const checkedIn = await readJSON(trackRoot, 'manifest.json');
      const checkedValidation = validateManifest(checkedIn);
      item.checkedInManifestMatches = checkedValidation.valid && isDeepStrictEqual(checkedIn, snapshot);
      if (!item.checkedInManifestMatches) {
        item.errors.push(issue('manifest-drift', 'manifest.json differs from the current legacy data/audio snapshot; review both before importing.'));
      }
    } catch (error) {
      item.errors.push(issue('manifest-file', `Cannot read checked-in manifest.json: ${error.message}`));
    }
    // Decode even when the checked-in copy drifts, so one problem does not hide
    // unrelated timing failures. Fingerprints also catch mid-audit byte changes.
    const result = await decode(snapshot, trackRoot);
    item.errors.push(...result.errors);
    item.warnings = result.warnings;
    item.measurements = result.measurements;
    item.measuredAssets = Object.keys(result.measurements).length;
    if (item.measuredAssets !== item.assets && !result.errors.length) {
      item.errors.push(issue('incomplete-measurements', 'Not every asset has a decoder measurement.'));
    }
    item.localChecksPassed = item.errors.length === 0;
  } catch (error) {
    item.errors.push(issue('source-file', error.message));
  }
  return item;
}

// No network, database, bucket, output-file or publication API is used here.
// decode is injectable for orchestration tests; the CLI always uses real decoding.
export async function auditOriginalLibrary({ publicRoot, ownerId = null, track = null, onTrack = () => {} }, { decode = probeManifest } = {}) {
  if (ownerId !== null && (typeof ownerId !== 'string' || !/^access:[a-f0-9]{64}$/.test(ownerId))) {
    throw new Error('Use an opaque Access administrator ID (access: plus 64 lowercase hex characters), not an email, token or local-seed placeholder.');
  }
  const root = await realpath(publicRoot);
  const tracksRoot = requireChild(root, await realpath(path.join(root, 'tracks')));
  const catalog = await readJSON(root, 'trackData.json');
  if (!catalog?.tracks || typeof catalog.tracks !== 'object' || Array.isArray(catalog.tracks)) throw new Error('Catalog must contain a tracks object.');
  const allEntries = Object.entries(catalog.tracks);
  const entries = allEntries.filter(([name]) => track === null || name === track);
  if (!entries.length) throw new Error('No matching catalog tracks.');
  const tracks = [];
  for (const [name, entry] of entries) {
    const item = await auditTrack(root, tracksRoot, name, entry, decode);
    tracks.push(item);
    onTrack(item);
  }
  const listed = new Set(allEntries.map(([, entry]) => entry?.basePath));
  const unlistedFolders = (await readdir(tracksRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !listed.has(`/tracks/${entry.name}`))
    .map(entry => entry.name).sort();
  return {
    reportVersion: 1, scope: 'original-library-local-audit', publishing: false,
    importReady: false, remoteStateChecked: false,
    selection: track === null ? 'all-catalog-tracks' : track,
    ownershipProposal: { ownerId, status: ownerId ? 'proposed-only' : 'unassigned', grantsAccess: false },
    totals: {
      catalogTracks: allEntries.length, auditedTracks: tracks.length,
      passedTracks: tracks.filter(item => item.localChecksPassed).length,
      failedTracks: tracks.filter(item => !item.localChecksPassed).length,
      assets: tracks.reduce((sum, item) => sum + item.assets, 0),
      audioBytes: tracks.reduce((sum, item) => sum + item.audioBytes, 0),
      measuredAssets: tracks.reduce((sum, item) => sum + item.measuredAssets, 0),
    },
    tracks, unlistedFolders,
    remainingGates: [
      'Review local failures and explicitly choose which test tracks to import; nothing is silently excluded.',
      'Confirm owner against a fresh authenticated admin session; this proposal grants no access.',
      'Compare original IDs and legacy keys with current D1 records and reserved/public destinations; do not match cloud smoke tests by title or audio hash.',
      'Implement identity-preserving private intake for originals; current new-track intake allocates unrelated IDs.',
      'Create a separately reviewed final version including measured durations; source snapshot version IDs/paths are not publication reservations.',
      'Run the private package, personal validation, approval and guarded publication workflow for each selected track; recheck changed files.',
      'Verify a real large track, remote playback/rooms and explicit release cutover before changing the live source.',
    ],
  };
}

export function formatLibraryAudit(report) {
  const lines = ['Gizmagick original-library audit — local only; no uploads, approval or publication.'];
  for (const item of report.tracks) {
    lines.push(`${item.localChecksPassed ? 'PASS' : 'FAIL'} ${item.legacyKey}: ${item.assets} assets, ${item.audioBytes} audio bytes, ${item.measuredAssets} measured${item.test ? ' [test track]' : ''}`);
    lines.push(`  ID ${item.trackId ?? 'unavailable'}; checked-in manifest ${item.checkedInManifestMatches ? 'matches' : 'not verified/mismatched'}`);
    for (const error of item.errors) lines.push(`  ${error.path} [${error.code}] ${error.message}`);
    if (item.warnings.length) lines.push(`  ${item.warnings.length} graph warnings (details in --json).`);
  }
  lines.push(`Totals: ${report.totals.passedTracks}/${report.totals.auditedTracks} passed; ${report.totals.assets} asset references; ${report.totals.audioBytes} audio bytes.`);
  lines.push(`Ownership: ${report.ownershipProposal.status}; remote state NOT checked; import NOT ready.`);
  if (report.unlistedFolders.length) lines.push(`Unlisted folders (not imported): ${report.unlistedFolders.join(', ')}`);
  lines.push('Remaining gates:', ...report.remainingGates.map(gate => `- ${gate}`));
  return lines.join('\n');
}
