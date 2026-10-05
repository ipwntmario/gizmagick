#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAudioFiles, convertLegacyTrack, fingerprintManifest, validateManifest } from './lib/track-manifests.mjs';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(frontendRoot, 'public');
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));

function parseArgs(args) {
  const [command = 'migrate', ...rest] = args;
  if (!['migrate', 'validate', 'help', '--help'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options = { command, write: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--dry-run') options.write = false;
    else if (['--track', '--output', '--audio-root'].includes(arg)) {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = rest[++i];
    } else if (command === 'validate' && !arg.startsWith('--') && !options.file) options.file = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (command === 'migrate' && (options.file || options['audio-root'])) throw new Error('migrate checks audio in each existing track folder.');
  if (command === 'validate' && (options.write || options.track || options.output)) throw new Error('validate accepts a manifest path and optional --audio-root.');
  return options;
}

function report(name, result) {
  const counts = new Map();
  for (const warning of result.warnings) counts.set(warning.code, (counts.get(warning.code) || 0) + 1);
  console.log(`${result.valid ? 'PASS' : 'FAIL'} ${name}: ${result.errors.length} errors, ${result.warnings.length} warnings`);
  for (const error of result.errors) console.error(`  ${error.path} [${error.code}] ${error.message}`);
  for (const [code, count] of counts) console.log(`  Warning ${code}: ${count}`);
}

async function validate(manifest, audioRoot) {
  const result = validateManifest(manifest);
  if (result.valid && audioRoot) result.errors.push(...await checkAudioFiles(manifest, audioRoot));
  result.valid = result.errors.length === 0;
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (['help', '--help'].includes(options.command)) {
    console.log('migrate [--dry-run | --write] [--track "Testing Time"] [--output directory]\nvalidate manifest.json [--audio-root track-directory]\nMigration defaults to dry-run. --write exports to frontend/.track-manifests; it never changes source files or the player.');
    return;
  }
  if (options.command === 'validate') {
    if (!options.file) throw new Error('Provide the path to a manifest JSON file.');
    const result = await validate(await readJSON(options.file), options['audio-root']);
    report(options.file, result);
    if (!options['audio-root']) console.log('Audio existence/duration not checked; provide --audio-root to check file existence.');
    if (!result.valid) process.exitCode = 1;
    return;
  }
  const catalog = await readJSON(path.join(publicRoot, 'trackData.json'));
  const entries = Object.entries(catalog.tracks).filter(([name]) => !options.track || name === options.track);
  if (!entries.length) throw new Error(`No catalog entry found for ${options.track}`);
  const candidates = [];
  for (const [name, entry] of entries) {
    try {
      // Legacy catalog paths must remain inside public/tracks.
      const trackRoot = path.resolve(publicRoot, `.${entry.basePath}`);
      const relative = path.relative(path.join(publicRoot, 'tracks'), trackRoot);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Unsafe catalog basePath: ${entry.basePath}`);
      let manifest = convertLegacyTrack(name, entry, await readJSON(path.join(trackRoot, 'clipData.json')), await readJSON(path.join(trackRoot, 'sectionData.json')));
      const result = await validate(manifest, trackRoot);
      report(name, result);
      if (!result.valid) process.exitCode = 1;
      else {
        manifest = await fingerprintManifest(manifest, trackRoot);
        candidates.push({ name, manifest });
      }
    } catch (error) {
      process.exitCode = 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  // Identify forgotten data without adding it to the published catalog.
  if (!options.track) {
    const folders = await readdir(path.join(publicRoot, 'tracks'), { withFileTypes: true });
    const catalogFolders = new Set(entries.map(([, entry]) => path.basename(entry.basePath)));
    for (const folder of folders.filter(folder => folder.isDirectory() && !catalogFolders.has(folder.name) && !folder.name.startsWith('_'))) {
      console.log(`Notice: ${folder.name} is not in trackData.json and is not imported.`);
    }
  }
  if (process.exitCode) {
    console.error('Validation failed. No manifests exported.');
    return;
  }
  if (!options.write) {
    console.log(`Dry run complete: ${candidates.length} tracks validated. No files written.`);
    return;
  }
  const output = path.resolve(options.output || path.join(frontendRoot, '.track-manifests'));
  // Export once; subsequent identical runs are no-ops. Changed exports require a
  // new directory so a saved conversion cannot be accidentally overwritten.
  const exports = candidates.map(({ name, manifest }) => ({
    name, manifest,
    file: path.join(output, manifest.track.id, manifest.versionId, 'manifest.json'),
    text: JSON.stringify(manifest, null, 2) + '\n',
  }));
  for (const item of exports) {
    try {
      if (await readFile(item.file, 'utf8') !== item.text) throw new Error(`Existing export differs: ${item.file}. Choose a new --output directory.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const item of exports) {
    await mkdir(path.dirname(item.file), { recursive: true });
    try { await writeFile(item.file, item.text, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(item.file, 'utf8') !== item.text) throw new Error(`Existing export differs: ${item.file}`);
    }
    console.log(`Exported ${item.name}: ${item.file}`);
  }
  console.log('Export complete. Audio stays in the original track folders.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
