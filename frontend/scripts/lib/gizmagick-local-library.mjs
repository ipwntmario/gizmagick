import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import unicodeRuntime from 'ajv/dist/runtime/ucs2length.js';
import equalRuntime from 'ajv/dist/runtime/equal.js';
import { schema, checkAudioFiles, convertLegacyTrack, fingerprintManifest, validateManifest } from './track-manifests.mjs';

export const GIZMAGICK_CATALOG_PATH = '/gizmagick-tracks/catalog.json';

export function createManifestValidatorSource() {
  const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true, code: { source: true, esm: true } });
  let source = standaloneCode(ajv, ajv.compile(schema));
  // Ajv's standalone emitter references two CJS runtime helpers for this schema.
  // Inline the package's actual pure functions so browser/Worker code needs no
  // require(), Node APIs, Ajv compiler, new Function(), or external dependencies.
  source = source.replaceAll('require("ajv/dist/runtime/ucs2length").default', `(${unicodeRuntime.default.toString()})`);
  source = source.replaceAll('require("ajv/dist/runtime/equal").default', `(${equalRuntime.default.toString()})`);
  if (/\brequire\(/.test(source)) throw new Error('Gizmagick manifest schema needs a new standalone runtime helper.');
  return source;
}

export async function createLocalLibrarySnapshot(publicRoot) {
  const { tracks } = JSON.parse(await readFile(path.join(publicRoot, 'trackData.json'), 'utf8'));
  const tracksRoot = await realpath(path.join(publicRoot, 'tracks'));
  const documents = new Map();
  const entries = [];
  for (const [name, entry] of Object.entries(tracks)) {
    if (typeof entry.basePath !== 'string' || !entry.basePath.startsWith('/tracks/')) throw new Error(`Unsafe Gizmagick track path: ${name}`);
    const trackRoot = await realpath(path.resolve(publicRoot, `.${entry.basePath}`));
    const relative = path.relative(tracksRoot, trackRoot);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Track path escapes Gizmagick library: ${name}`);
    const readJSON = async file => JSON.parse(await readFile(path.join(trackRoot, file), 'utf8'));
    const converted = convertLegacyTrack(name, entry, await readJSON('clipData.json'), await readJSON('sectionData.json'));
    const validation = validateManifest(converted);
    if (validation.valid) validation.errors.push(...await checkAudioFiles(converted, trackRoot));
    if (validation.errors.length) throw new Error(`Invalid Gizmagick track ${name}: ${validation.errors.map(error => `${error.path}: ${error.message}`).join('; ')}`);
    const manifest = await fingerprintManifest(converted, trackRoot);
    const manifestUrl = `/gizmagick-tracks/${manifest.track.id}/${manifest.versionId}/manifest.json`;
    documents.set(manifestUrl, JSON.stringify(manifest));
    entries.push([name, {
      id: manifest.track.id,
      versionId: manifest.versionId,
      manifestUrl,
      // Audio still lives in the original public folder during Phase 3.
      basePath: entry.basePath,
      defaultDisplayName: manifest.track.title,
      firstSection: manifest.track.firstSection,
      simple: manifest.track.simple,
      test: manifest.track.test,
    }]);
  }
  const catalog = { schemaVersion: 2, tracks: Object.fromEntries(entries) };
  documents.set(GIZMAGICK_CATALOG_PATH, JSON.stringify(catalog));
  return { catalog, documents };
}
