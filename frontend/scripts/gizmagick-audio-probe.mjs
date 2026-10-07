import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { convertLegacyTrack, validateManifest } from './lib/track-manifests.mjs';
import { probeManifest, createProbeReport, readProbeFile } from './lib/audio-probe.mjs';
import { REVIEW_POLICY, REVIEW_PACKAGE_BYTES, createReviewReport, checkReviewReport, jsonSha256 } from '../../shared/draft-review.js';

const usage = 'Usage: npm run tracks:probe -- --track "Lena\'s Home"\n   or: npm run tracks:probe -- --manifest <manifest.json> --track-root <directory containing audio/>\n   or: node scripts/gizmagick-audio-probe.mjs --review-package <draft-review-package.json> --track-root <directory containing audio/>';
try {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--track', '--manifest', '--track-root', '--review-package'].includes(key) || !value || value.startsWith('--') || options[key]) throw new Error(usage);
    options[key] = value;
  }
  const readJSON = async (file, maximum = 262144) => {
    const bytes = await readProbeFile(file, maximum, 'Metadata');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
  let manifest, root, job;
  if (options['--track'] && Object.keys(options).length === 1) {
    const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
    const catalog = await readJSON(path.join(publicRoot, 'trackData.json'));
    const entry = catalog.tracks[options['--track']];
    if (!Object.hasOwn(catalog.tracks, options['--track'])) throw new Error('Unknown catalog track.');
    if (typeof entry.basePath !== 'string') throw new Error('Invalid catalog basePath.');
    root = path.resolve(publicRoot, `.${entry.basePath}`);
    const relative = path.relative(path.join(publicRoot, 'tracks'), root);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Catalog path escapes the tracks directory.');
    manifest = convertLegacyTrack(options['--track'], entry,
      await readJSON(path.join(root, 'clipData.json')), await readJSON(path.join(root, 'sectionData.json')));
  } else if (options['--manifest'] && options['--track-root'] && Object.keys(options).length === 2) {
    manifest = await readJSON(path.resolve(options['--manifest'])); root = path.resolve(options['--track-root']);
  } else if (options['--review-package'] && options['--track-root'] && Object.keys(options).length === 2) {
    job = await readJSON(path.resolve(options['--review-package']), REVIEW_PACKAGE_BYTES);
    manifest = job.snapshot?.manifest; root = path.resolve(options['--track-root']);
    if (job.packageVersion !== 1 || job.policy !== REVIEW_POLICY || typeof job.jobId !== 'string'
        || !Number.isSafeInteger(job.expiresAt) || job.expiresAt <= Date.now() / 1000
        || !Array.isArray(job.snapshot?.assets) || job.snapshot.assets.length > 256
        || !validateManifest(manifest).valid || job.snapshotSha256 !== await jsonSha256(job.snapshot)) {
      throw new Error('Invalid, altered, or expired review package. Download a fresh package from your private draft.');
    }
  } else throw new Error(usage);
  const result = await probeManifest(manifest, root);
  let report = createProbeReport(manifest, result);
  if (job) {
    report = await createReviewReport(job, report);
    if (report.valid) {
      const checked = await checkReviewReport(job, report, validateManifest);
      if (!checked.valid) { report.valid = false; report.errors = checked.errors; }
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.valid) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
