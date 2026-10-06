import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { validateManifestWithStructure } from '../../../shared/track-manifest.js';
import { convertLegacyDocument } from '../../../shared/legacy-manifest.js';

export const schema = JSON.parse(await readFile(new URL('../../../shared/track-manifest.schema.json', import.meta.url), 'utf8'));
const checkStructure = new Ajv({ allErrors: true, strict: true, ownProperties: true }).compile(schema);

export function validateManifest(manifest) {
  return validateManifestWithStructure(manifest, checkStructure);
}

// RFC 4122 UUIDv5 using the standard URL namespace. Only initial legacy import
// derives identity from a name. Once imported, persist the UUID through renames.
function uuidFor(value) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function convertLegacyTrack(name, catalogEntry, clipDocument, sectionDocument, { trackId } = {}) {
  return assignVersion(convertLegacyDocument(name, catalogEntry, clipDocument, sectionDocument, {
    trackId: trackId ?? uuidFor(`urn:gizmagick:legacy-track:${name}`),
    assetIdFor: file => uuidFor(`urn:gizmagick:legacy-asset:${file}`),
  }));
}
function assignVersion(document) {
  return { ...document, versionId: uuidFor(`urn:gizmagick:legacy-version:${stableJSON(document)}`) };
}

// File fingerprints distinguish two imports with identical metadata but changed
// audio bytes. Durations require decoding/probing and are not guessed here.
export async function fingerprintManifest(manifest, trackRoot) {
  const { versionId: _versionId, ...document } = structuredClone(manifest);
  for (const asset of Object.values(document.assets)) {
    const bytes = await readFile(path.join(trackRoot, asset.path));
    asset.byteLength = bytes.length;
    asset.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  return assignVersion(document);
}

export async function checkAudioFiles(manifest, trackRoot) {
  const root = await realpath(trackRoot);
  const errors = [];
  for (const [id, asset] of Object.entries(manifest.assets)) {
    try {
      const file = await realpath(path.join(root, asset.path));
      const relative = path.relative(root, file);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Resolved audio path escapes the track directory.');
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) throw new Error('Audio must be a nonempty file.');
      if (asset.byteLength !== undefined && asset.byteLength !== info.size) throw new Error(`Expected ${asset.byteLength} bytes; found ${info.size}.`);
      if (asset.sha256 !== undefined && createHash('sha256').update(await readFile(file)).digest('hex') !== asset.sha256) throw new Error('Audio checksum does not match the manifest.');
    } catch (error) {
      errors.push({ path: `/assets/${id}/path`, code: 'audio-file', message: `${asset.path}: ${error.message}` });
    }
  }
  return errors;
}
