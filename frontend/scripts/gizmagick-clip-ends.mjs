import path from 'node:path';
import { readProbeFile } from './lib/audio-probe.mjs';
import { prepareClipEnds } from './lib/clip-end-preparation.mjs';

const usage = 'Usage: node scripts/gizmagick-clip-ends.mjs --manifest <working-metadata.json> --track-root <directory containing audio/>\nLocal-only clipEnd proposal. No source files, database records or audio are written. This is not a review report or approval.';
try {
  const args = process.argv.slice(2), options = {};
  if (args.length === 1 && args[0] === '--help') console.log(usage);
  else {
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (!['--manifest', '--track-root'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(usage);
      options[key] = value;
    }
    if (Object.keys(options).length !== 2) throw new Error(usage);
    const bytes = await readProbeFile(path.resolve(options['--manifest']), 262144, 'Metadata');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const report = await prepareClipEnds(manifest, path.resolve(options['--track-root']));
    const output = JSON.stringify(report, null, 2);
    if (Buffer.byteLength(output) > 1048576) throw new Error('Preparation report exceeds 1 MiB; no proposal was exported.');
    process.stdout.write(output + '\n');
    if (!report.valid) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
