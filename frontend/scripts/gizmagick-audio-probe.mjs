import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { convertLegacyTrack } from './lib/track-manifests.mjs';
import { probeManifest, createProbeReport, readProbeFile } from './lib/audio-probe.mjs';

const usage = 'Usage: npm run tracks:probe -- --track "Lena\'s Home"\n   or: npm run tracks:probe -- --manifest <manifest.json> --track-root <directory containing audio/>';
try {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--track', '--manifest', '--track-root'].includes(key) || !value || value.startsWith('--') || options[key]) throw new Error(usage);
    options[key] = value;
  }
  const readJSON = async file => {
    const bytes = await readProbeFile(file, 262144, 'Metadata');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
  let manifest, root;
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
  } else throw new Error(usage);
  const result = await probeManifest(manifest, root);
  process.stdout.write(JSON.stringify(createProbeReport(manifest, result), null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
