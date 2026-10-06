import { walk } from './track-manifest.js';

// Pure adapter shared by deterministic legacy migration and private draft intake.
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

export function convertLegacyDocument(name, catalogEntry, clipDocument, sectionDocument, { trackId, assetIdFor } = {}) {
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
        const assetId = assetIdFor(file);
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
    id: trackId,
    slug: name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track',
    title: catalogEntry.defaultDisplayName || name,
    firstSection: catalogEntry.firstSection,
    simple: catalogEntry.simple,
    test: catalogEntry.test ?? false,
  };
  const document = { schemaVersion: 2, track, assets, clips, sections };
  return document;
}
