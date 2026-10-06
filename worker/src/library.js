import { LIBRARY_CATALOG_PATH, UUID_PATTERN, libraryVersionLocation, safeLibraryKey } from '../../shared/library-contract.js';

const publicVersionSQL = `SELECT t.id, t.legacy_key, v.version_id, v.manifest_key, v.title, v.first_section, v.simple, v.test
  FROM library_tracks t JOIN library_track_versions v ON v.track_id = t.id
  WHERE t.visibility = 'public' AND t.status = 'published' AND v.status = 'published'`;

function catalogEntry(row, env) {
  const location = libraryVersionLocation(env.GIZMAGICK_MEDIA_BASE_URL, row.id, row.version_id);
  if (location.manifestKey !== row.manifest_key || !safeLibraryKey(row.legacy_key ?? row.id)) throw new Error('Invalid stored library metadata');
  return {
    id: row.id, versionId: row.version_id, manifestUrl: location.manifestUrl,
    basePath: location.basePath, defaultDisplayName: row.title, firstSection: row.first_section,
    simple: row.simple === 1, test: row.test === 1,
  };
}

export async function handleLibraryRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/library/')) return null;
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' });
  const origin = request.headers.get('Origin');
  const allowed = (env.GIZMAGICK_APP_ORIGINS || '').split(',').map(value => value.trim());
  const reply = (body, status = 200) => {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
  };
  if (origin && !allowed.includes(origin)) return reply({ error: 'Origin not allowed' }, 403);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'HEAD'].includes(request.method)) {
    headers.set('Allow', 'GET, HEAD, OPTIONS');
    return reply({ error: 'Library API is read-only' }, 405);
  }
  const versionRoute = url.pathname.match(/^\/api\/library\/tracks\/([^/]+)\/versions\/([^/]+)$/);
  const mediaRoute = url.pathname.match(/^\/api\/library\/media\/tracks\/([^/]+)\/versions\/([^/]+)\/(manifest\.json|audio\/[^/]+)$/);
  const route = versionRoute || mediaRoute;
  if (url.pathname !== LIBRARY_CATALOG_PATH && !route) return reply({ error: 'Not found' }, 404);
  if (route && (!UUID_PATTERN.test(route[1]) || !UUID_PATTERN.test(route[2]))) return reply({ error: 'Not found' }, 404);
  if (!env.GIZMAGICK_DB) return reply({ error: 'Library is not configured' }, 503);
  try {
    if (url.pathname === LIBRARY_CATALOG_PATH) {
      const { results } = await env.GIZMAGICK_DB.prepare(`${publicVersionSQL} AND v.version_id = t.current_version_id ORDER BY t.id`).all();
      const entries = results.map(row => [row.legacy_key ?? row.id, catalogEntry(row, env)]);
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate catalog key');
      return reply({ schemaVersion: 2, tracks: Object.fromEntries(entries) });
    }
    const row = await env.GIZMAGICK_DB.prepare(`${publicVersionSQL} AND t.id = ? AND v.version_id = ?`).bind(route[1], route[2]).first();
    if (!row) return reply({ error: 'Not found' }, 404);
    if (versionRoute) return reply(catalogEntry(row, env));

    // Same immutable layout as the public domain, for local R2 smoke tests.
    // Private, staged, archived and arbitrary bucket objects are never exposed.
    if (!env.GIZMAGICK_MEDIA) return reply({ error: 'Media is not configured' }, 503);
    let suffix;
    try { suffix = decodeURIComponent(mediaRoute[3]); } catch { return reply({ error: 'Not found' }, 404); }
    if (suffix !== 'manifest.json' && !/^audio\/[^.\/\\\u0000-\u001f][^\/\\\u0000-\u001f]*\.ogg$/i.test(suffix)) return reply({ error: 'Not found' }, 404);
    const key = `${libraryVersionLocation(env.GIZMAGICK_MEDIA_BASE_URL, row.id, row.version_id).prefix}/${suffix}`;
    const object = request.method === 'HEAD' ? await env.GIZMAGICK_MEDIA.head(key) : await env.GIZMAGICK_MEDIA.get(key);
    if (!object) return reply({ error: 'Not found' }, 404);
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', suffix === 'manifest.json' ? 'application/json' : 'audio/ogg');
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Content-Length', String(object.size));
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  } catch {
    // Do not leak SQL, resource IDs or private metadata in public errors.
    return reply({ error: 'Library is temporarily unavailable' }, 503);
  }
}
