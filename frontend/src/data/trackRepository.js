import { manifestToEngineData } from '../../../shared/track-manifest.js';
import { LIBRARY_CATALOG_PATH, UUID_PATTERN, libraryVersionLocation, normalizeMediaBase } from '../../../shared/library-contract.js';
import { validTrackRef } from '../../../shared/room-library.js';

const uuidPattern = UUID_PATTERN;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'prototype', 'constructor'].includes(key);

export function createTrackRepository({ source = 'legacy', fetchImpl = globalThis.fetch, validateManifest, remoteCatalogUrl = LIBRARY_CATALOG_PATH, mediaBaseUrl } = {}) {
  if (!['legacy', 'manifest', 'remote'].includes(source)) throw new Error(`Unknown Gizmagick track source: ${source}`);
  if (source !== 'legacy' && typeof validateManifest !== 'function') throw new Error('Gizmagick manifest validation is required.');
  const mediaBase = source === 'remote' ? normalizeMediaBase(mediaBaseUrl) : null;
  if (source === 'remote' && remoteCatalogUrl !== LIBRARY_CATALOG_PATH) normalizeMediaBase(remoteCatalogUrl);
  const catalogUrl = source === 'remote' ? remoteCatalogUrl : source === 'manifest' ? '/gizmagick-tracks/catalog.json' : '/trackData.json';
  const metadata = new Map(), pending = new Map();
  let catalogPromise;

  async function fetchJSON(url, label) {
    const response = await fetchImpl(encodeURI(url), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load ${label} (${response.status})`);
    try { return await response.json(); }
    catch { throw new Error(`Invalid JSON in ${label}`); }
  }

  function checkCatalog(document) {
    if (!isObject(document) || !isObject(document.tracks) || (source !== 'legacy' && document.schemaVersion !== 2)) throw new Error('Invalid Gizmagick track catalog');
    const identities = new Set();
    for (const [name, track] of Object.entries(document.tracks)) {
      if (!safeKey(name) || !isObject(track) || typeof track.basePath !== 'string' || (source !== 'remote' && !track.basePath.startsWith('/tracks/')) || typeof track.firstSection !== 'string' || typeof track.simple !== 'boolean') throw new Error(`Invalid Gizmagick catalog entry: ${name}`);
      if (source !== 'legacy') {
        if (typeof track.id !== 'string' || typeof track.versionId !== 'string' || !uuidPattern.test(track.id) || !uuidPattern.test(track.versionId) || typeof track.manifestUrl !== 'string' || (source === 'manifest' && !track.manifestUrl.startsWith('/gizmagick-tracks/')) || typeof track.defaultDisplayName !== 'string' || typeof track.test !== 'boolean' || identities.has(track.id)) throw new Error(`Invalid Gizmagick manifest catalog entry: ${name}`);
        if (source === 'remote') {
          const location = libraryVersionLocation(mediaBase, track.id, track.versionId);
          if (track.basePath !== location.basePath || track.manifestUrl !== location.manifestUrl) throw new Error(`Untrusted Gizmagick media location: ${name}`);
        }
        identities.add(track.id);
      }
    }
    return document.tracks;
  }

  function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetchJSON(catalogUrl, 'Gizmagick catalog').then(checkCatalog).catch(error => {
        catalogPromise = undefined;
        throw error;
      });
    }
    return catalogPromise;
  }

  async function loadTrack(name, pin = null) {
    let entry;
    if (pin) {
      if (source !== 'remote' || !validTrackRef(pin)) throw new Error('Invalid Gizmagick room track reference');
      // Resolve the exact historical version through the same trusted API, never
      // through the catalog's mutable current-version pointer or a socket URL.
      const versionUrl = `${catalogUrl.slice(0, -'/catalog'.length)}/tracks/${pin.trackId}/versions/${pin.versionId}`;
      entry = await fetchJSON(versionUrl, `${name} pinned version`);
      checkCatalog({ schemaVersion: 2, tracks: { [name]: entry } });
      if (entry.id !== pin.trackId || entry.versionId !== pin.versionId) throw new Error('Gizmagick pinned version identity mismatch');
    } else entry = (await loadCatalog())[name];
    if (!entry) throw new Error(`Unknown Gizmagick track: ${name}`);
    // Version identity stays attached to cached metadata. Compatibility names
    // remain UI/preference keys; remote rooms additionally carry explicit pins.
    const key = JSON.stringify([source, entry.id || name, entry.versionId || entry.basePath]);
    if (metadata.has(key)) return metadata.get(key);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      let data;
      if (source !== 'legacy') {
        const manifest = await fetchJSON(entry.manifestUrl, `${name} manifest`);
        const validation = validateManifest(manifest);
        if (!validation.valid) throw new Error(`Invalid ${name} manifest: ${validation.errors[0]?.path}: ${validation.errors[0]?.message}`);
        if (manifest.track.id !== entry.id || manifest.versionId !== entry.versionId || manifest.track.title !== entry.defaultDisplayName || manifest.track.firstSection !== entry.firstSection || manifest.track.simple !== entry.simple || manifest.track.test !== entry.test) throw new Error(`Gizmagick catalog/manifest mismatch for ${name}`);
        data = { ...manifestToEngineData(manifest), trackId: entry.id, versionId: entry.versionId, warnings: validation.warnings };
      } else {
        const [clipDocument, sectionDocument] = await Promise.all([
          fetchJSON(`${entry.basePath}/clipData.json`, `${name} clips`),
          fetchJSON(`${entry.basePath}/sectionData.json`, `${name} sections`),
        ]);
        const clips = clipDocument?.clips || clipDocument;
        const sections = sectionDocument?.sections || sectionDocument;
        if (!isObject(clips) || !isObject(sections) || !Object.hasOwn(sections, entry.firstSection)) throw new Error(`Invalid ${name} track metadata`);
        data = { clips, sections };
      }
      const result = { ...data, basePath: entry.basePath, entry };
      metadata.set(key, result);
      return result;
    })();
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  }

  return { source, loadCatalog, loadTrack };
}
