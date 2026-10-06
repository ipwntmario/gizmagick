import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { validateManifestWithStructure, walk } from '../../../shared/track-manifest.js';

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

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function allowedKeys(value, allowed, label) {
  requireObject(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}: unsupported fields ${unknown.join(', ')}. Refusing to silently discard data.`);
}

function list(value, label) {
  if (value === undefined || value === null || value === '') return [];
  const result = Array.isArray(value) ? value : [value];
  if (result.some(item => typeof item !== 'string' || !item)) throw new Error(`${label} must contain nonempty string references.`);
  return result;
}

export function convertLegacyTrack(name, catalogEntry, clipDocument, sectionDocument, { trackId } = {}) {
  allowedKeys(catalogEntry, ['defaultDisplayName', 'basePath', 'firstSection', 'simple', 'test'], 'Catalog entry');
  allowedKeys(clipDocument, ['clips'], 'Clip document');
  allowedKeys(sectionDocument, ['sections'], 'Section document');
  requireObject(clipDocument.clips, 'clips');
  requireObject(sectionDocument.sections, 'sections');
  const assetIds = new Map();
  const assets = {};
  const clips = Object.fromEntries(Object.entries(clipDocument.clips).map(([id, clip]) => {
    allowedKeys(clip, ['file', 'loopStart', 'loopPoint', 'clipEnd', 'nextClip'], `Clip ${id}`);
    const files = typeof clip.file === 'string' ? { base: clip.file } : clip.file;
    requireObject(files, `Clip ${id}.file`);
    const assetsByMode = Object.fromEntries(Object.entries(files).map(([mode, file]) => {
      if (typeof file !== 'string' || !file) throw new Error(`Clip ${id} mode ${mode} requires an audio filename.`);
      if (!assetIds.has(file)) {
        const assetId = uuidFor(`urn:gizmagick:legacy-asset:${file}`);
        assetIds.set(file, assetId);
        assets[assetId] = { path: `audio/${file}` };
      }
      return [mode, assetIds.get(file)];
    }));
    const weights = new Map();
    for (const target of list(clip.nextClip, `Clip ${id}.nextClip`)) weights.set(target, (weights.get(target) || 0) + 1);
    return [id, {
      assetsByMode,
      loopStart: clip.loopStart ?? 0,
      loopPoint: clip.loopPoint,
      clipEnd: clip.clipEnd,
      transitions: [...weights].map(([to, weight]) => ({ to, weight })),
    }];
  }));
  const sections = Object.fromEntries(Object.entries(sectionDocument.sections).map(([id, section]) => {
    allowedKeys(section, ['defaultDisplayName', 'defaultButtonName', 'defaultBaseModeName', 'firstClip', 'nextSection', 'type', 'modes'], `Section ${id}`);
    if (!['', undefined, 'auto', 'end'].includes(section.type)) throw new Error(`Section ${id}: unsupported type ${section.type}`);
    return [id, {
      title: section.defaultDisplayName || id,
      ...(section.defaultButtonName ? { buttonLabel: section.defaultButtonName } : {}),
      ...(section.defaultBaseModeName ? { baseModeLabel: section.defaultBaseModeName } : {}),
      firstClip: section.firstClip,
      // Discover membership from actual graph edges, never filename prefixes.
      clips: [...walk(section.firstClip, id => clips[id]?.transitions.map(t => t.to) || [])],
      type: section.type || 'manual',
      nextSections: list(section.nextSection, `Section ${id}.nextSection`),
      modes: list(section.modes, `Section ${id}.modes`),
    }];
  }));
  const track = {
    id: trackId ?? uuidFor(`urn:gizmagick:legacy-track:${name}`),
    slug: name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track',
    title: catalogEntry.defaultDisplayName || name,
    firstSection: catalogEntry.firstSection,
    simple: catalogEntry.simple,
    test: catalogEntry.test ?? false,
  };
  const document = { schemaVersion: 2, track, assets, clips, sections };
  // The first imported snapshot has a reproducible UUID. Future publication
  // issues a fresh version ID and retains track.id; draft IDs are not pointers.
  return assignVersion(document);
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
