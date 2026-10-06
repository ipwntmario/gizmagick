// Canonical locations shared by the catalog API and browser repository.
export const LIBRARY_CATALOG_PATH = '/api/library/catalog';
export const DEFAULT_MEDIA_BASE_URL = 'https://media.gizmagick.com';
export const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const safeLibraryKey = key => typeof key === 'string' && key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key);

export function normalizeMediaBase(value = DEFAULT_MEDIA_BASE_URL) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname.includes('%')) {
    throw new Error('Gizmagick media base must be HTTPS (HTTP is allowed only on localhost), without credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

export function libraryVersionLocation(mediaBase, trackId, versionId) {
  if (typeof trackId !== 'string' || typeof versionId !== 'string' || !UUID_PATTERN.test(trackId) || !UUID_PATTERN.test(versionId)) throw new Error('Invalid Gizmagick track/version identity');
  const prefix = `tracks/${trackId}/versions/${versionId}`;
  const basePath = `${normalizeMediaBase(mediaBase)}/${prefix}`;
  return { basePath, manifestUrl: `${basePath}/manifest.json`, manifestKey: `${prefix}/manifest.json`, prefix };
}

export function assertRemoteBuildConfiguration({ source, command, catalogUrl, mediaBaseUrl }) {
  if (source !== 'remote' || command !== 'build') return;
  for (const [name, value] of [['VITE_GIZMAGICK_CATALOG_URL', catalogUrl], ['VITE_GIZMAGICK_MEDIA_BASE_URL', mediaBaseUrl]]) {
    if (!value) throw new Error(`Remote production builds require ${name}.`);
    const url = new URL(normalizeMediaBase(value));
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${name} must be a production HTTPS URL, not localhost.`);
  }
}
