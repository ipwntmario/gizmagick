import checkStructure from './generated/manifest-validator.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { convertLegacyDocument } from '../../shared/legacy-manifest.js';
import { UUID_PATTERN } from '../../shared/library-contract.js';
import { getDraftReview, handleReviewRequest, reviewsEnabled } from './admin-reviews.js';
import { jsonSha256 } from '../../shared/draft-review.js';

export const DRAFT_LIMITS = Object.freeze({ metadataBytes: 262144, audioBytes: 16777216,
  draftBytes: 268435456, ownerBytes: 536870912, activeDrafts: 20, assets: 256, clips: 2048, sections: 128 });
export class DraftError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
const fail = (status, code, message, details) => { throw new DraftError(status, code, message, details); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
export const draftsEnabled = env => env.GIZMAGICK_DRAFT_UPLOADS_ENABLED === 'true'
  && Boolean(env.GIZMAGICK_DB && env.GIZMAGICK_DRAFTS) && env.GIZMAGICK_DRAFTS !== env.GIZMAGICK_MEDIA;
// Editing must be able to detect immutable attestations (migration 0003).
export const metadataEnabled = env => draftsEnabled(env) && reviewsEnabled(env)
  && env.GIZMAGICK_DRAFT_METADATA_ENABLED === 'true';

function requireKeys(value, keys) {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) fail(400, 'DRAFT_INPUT', 'Unsupported draft fields. Ownership and publication are server-controlled.');
}

// Enforce the actual byte count, even for chunked bodies or lying length headers.
export async function readBoundedBody(request, maximum) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) fail(413, 'DRAFT_TOO_LARGE', `Maximum request size is ${maximum} bytes.`);
  if (!request.body) fail(400, 'DRAFT_EMPTY', 'A nonempty upload body is required.');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); fail(413, 'DRAFT_TOO_LARGE', `Maximum request size is ${maximum} bytes.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) fail(400, 'DRAFT_EMPTY', 'A nonempty upload body is required.');
  if (length !== null && Number(length) !== size) fail(400, 'DRAFT_LENGTH', 'Upload length does not match its declared length.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function boundedGraph(manifest) {
  if (!isObject(manifest)) fail(422, 'DRAFT_MANIFEST', 'A track manifest is required.');
  for (const [key, limit] of [['assets', DRAFT_LIMITS.assets], ['clips', DRAFT_LIMITS.clips], ['sections', DRAFT_LIMITS.sections]]) {
    if (!isObject(manifest[key]) || Object.keys(manifest[key]).length > limit) fail(422, 'DRAFT_GRAPH_LIMIT', `${key} must be an object with at most ${limit} entries.`);
  }
}

function prepareManifest(input) {
  let manifest;
  if (input.format === 'legacy') {
    requireKeys(input, ['format', 'requestId', 'title', 'firstSection', 'simple', 'test', 'clipData', 'sectionData']);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300
        || typeof input.firstSection !== 'string' || typeof input.simple !== 'boolean'
        || (input.test !== undefined && typeof input.test !== 'boolean')) fail(422, 'DRAFT_INPUT', 'Supply a title, first section, and simple-track setting.');
    // Bound the graph before the legacy adapter walks it. Unknown legacy fields
    // are rejected by the shared adapter rather than silently dropped.
    boundedGraph({ assets: {}, clips: input.clipData?.clips, sections: input.sectionData?.sections });
    try {
      manifest = { ...convertLegacyDocument(input.title, { defaultDisplayName: input.title.trim(), firstSection: input.firstSection,
        simple: input.simple, test: input.test ?? false }, input.clipData, input.sectionData,
      { trackId: crypto.randomUUID(), assetIdFor: () => crypto.randomUUID() }), versionId: crypto.randomUUID() };
    } catch (error) { fail(422, 'DRAFT_LEGACY', error.message); }
  } else {
    requireKeys(input, ['requestId', 'manifest']);
    manifest = input.manifest;
  }
  boundedGraph(manifest);
  const validation = validateManifestWithStructure(manifest, checkStructure);
  if (!validation.valid) fail(422, 'DRAFT_MANIFEST', 'Track data did not pass validation.', validation.errors.slice(0, 30));
  // New-track drafts cannot select/update an existing public identity. Supplied
  // fingerprints remain constraints to check, not trusted audio measurements.
  manifest = structuredClone(manifest);
  manifest.track.id = crypto.randomUUID();
  manifest.versionId = crypto.randomUUID();
  return { manifest, warnings: validation.warnings.slice(0, 30) };
}

async function ownDraft(db, id, owner) {
  const row = await db.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(id, owner).first();
  if (!row) fail(404, 'DRAFT_NOT_FOUND', 'Draft not found.');
  return row;
}

async function detail(env, row) {
  const db = env.GIZMAGICK_DB;
  const { results } = await db.prepare('SELECT asset_id, byte_length, sha256, state FROM admin_draft_assets WHERE draft_id = ? ORDER BY asset_id').bind(row.id).all();
  const manifest = JSON.parse(row.manifest_json);
  const uploaded = new Set(results.filter(asset => asset.state === 'uploaded').map(asset => asset.asset_id));
  const review = await getDraftReview(env, row.id);
  return { id: row.id, title: row.title, status: row.status, createdAt: row.created_at, manifest,
    manifestSha256: await jsonSha256(manifest), metadataEditable: metadataEnabled(env) && row.status === 'draft' && !review,
    uploads: results, missingAssets: Object.keys(manifest.assets).filter(id => !uploaded.has(id)),
    audioProbed: false, publishing: false, review,
    warnings: validateManifestWithStructure(manifest, checkStructure).warnings.slice(0, 30) };
}

async function updateMetadata(request, env, principal, row) {
  if (!metadataEnabled(env)) fail(503, 'DRAFT_METADATA_DISABLED', 'Private metadata editing is not enabled.');
  if (principal.role !== 'admin') fail(403, 'DRAFT_METADATA_ADMIN', 'Only an administrator can edit private metadata.');
  if (row.status !== 'draft' || await getDraftReview(env, row.id)) fail(409, 'DRAFT_METADATA_LOCKED', 'Archived or attested drafts are immutable. Create a new draft instead.');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'DRAFT_JSON', 'Send application/json.');
  const bytes = await readBoundedBody(request, DRAFT_LIMITS.metadataBytes);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'DRAFT_JSON', 'Invalid UTF-8 JSON.'); }
  requireKeys(input, ['expectedManifestSha256', 'manifest']);
  if (typeof input.expectedManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedManifestSha256)) fail(400, 'DRAFT_METADATA_BASE', 'The loaded manifest checksum is required.');
  const manifest = input.manifest;
  boundedGraph(manifest);
  const validation = validateManifestWithStructure(manifest, checkStructure);
  if (!validation.valid) fail(422, 'DRAFT_MANIFEST', 'Track data did not pass validation.', validation.errors.slice(0, 30));
  const original = JSON.parse(row.manifest_json);
  const sameAssets = Object.keys(manifest.assets).length === Object.keys(original.assets).length
    && Object.entries(original.assets).every(([id, asset]) => Object.hasOwn(manifest.assets, id)
      && Object.keys(asset).length === Object.keys(manifest.assets[id]).length
      && Object.entries(asset).every(([key, value]) => manifest.assets[id][key] === value));
  if (manifest.track.id !== original.track.id || manifest.versionId !== original.versionId || !sameAssets) {
    fail(422, 'DRAFT_METADATA_IDENTITY', 'Keep track/version IDs and all audio asset IDs, paths and constraints unchanged. New audio requires a new draft.');
  }
  const document = JSON.stringify(manifest);
  // Exact-content retry after a lost response is harmless; no old report is approved.
  if (document === row.manifest_json) return detail(env, row);
  if (input.expectedManifestSha256 !== await jsonSha256(original)) fail(409, 'DRAFT_METADATA_STALE', 'The draft changed in another session. Copy your edits before reopening the latest draft.');
  const saved = await env.GIZMAGICK_DB.prepare(`UPDATE admin_drafts SET title = ?, manifest_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND owner_id = ? AND status = 'draft' AND manifest_json = ?
    AND NOT EXISTS (SELECT 1 FROM admin_draft_reviews WHERE draft_id = ?)`)
    .bind(manifest.track.title, document, row.id, principal.id, row.manifest_json, row.id).run();
  if (!changed(saved)) fail(409, 'DRAFT_METADATA_STALE', 'The draft changed, was archived, or was attested while saving. Copy your edits before reopening it.');
  // Keep historical pending packages. Their snapshot hashes no longer match;
  // regeneration replaces the old job and reports cannot attest stale metadata.
  return detail(env, await ownDraft(env.GIZMAGICK_DB, row.id, principal.id));
}

// Container/codec identification is an intake check, NOT decoding/duration
// validation. Every draft stays quarantined until a later trusted audio probe.
export function checkOggIntake(bytes) {
  const text = (offset, size) => new TextDecoder().decode(bytes.subarray(offset, offset + size));
  if (bytes.length < 28 || text(0, 4) !== 'OggS' || bytes[4] !== 0 || !(bytes[5] & 2) || bytes[26] < 1) fail(422, 'DRAFT_AUDIO_TYPE', 'Expected an Ogg stream with an Opus or Vorbis identification header.');
  const start = 27 + bytes[26];
  const firstPacket = bytes[27];
  const opus = firstPacket >= 19 && text(start, 8) === 'OpusHead';
  const vorbis = firstPacket >= 30 && bytes[start] === 1 && text(start + 1, 6) === 'vorbis';
  if (start + firstPacket > bytes.length || (!opus && !vorbis)) fail(422, 'DRAFT_AUDIO_TYPE', 'Expected an Ogg stream with an Opus or Vorbis identification header.');
}

async function uploadAsset(request, env, principal, row, assetId) {
  if (row.status !== 'draft') fail(409, 'DRAFT_ARCHIVED', 'Archived drafts cannot receive uploads.');
  const manifest = JSON.parse(row.manifest_json);
  if (!Object.hasOwn(manifest.assets, assetId)) fail(404, 'DRAFT_ASSET', 'That asset is not referenced by this draft.');
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!['audio/ogg', 'application/ogg', 'application/octet-stream'].includes(contentType)) fail(415, 'DRAFT_AUDIO_TYPE', 'Upload Ogg audio as audio/ogg or application/octet-stream.');
  const bytes = await readBoundedBody(request, DRAFT_LIMITS.audioBytes);
  checkOggIntake(bytes);
  const hash = await digest(bytes), asset = manifest.assets[assetId];
  if ((asset.byteLength !== undefined && asset.byteLength !== bytes.length) || (asset.sha256 !== undefined && asset.sha256 !== hash)) fail(422, 'DRAFT_FINGERPRINT', 'Audio does not match the manifest file size/checksum.');
  // One atomic conditional INSERT reserves capacity before writing R2. Pending
  // and archived allocations still count, including interrupted uploads.
  await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_assets (draft_id, asset_id, object_key, byte_length, sha256)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin_drafts WHERE id = ? AND owner_id = ? AND status = 'draft')
    AND COALESCE((SELECT SUM(byte_length) FROM admin_draft_assets WHERE draft_id = ?), 0) + ? <= ?
    AND COALESCE((SELECT SUM(a.byte_length) FROM admin_draft_assets a JOIN admin_drafts d ON d.id = a.draft_id WHERE d.owner_id = ?), 0) + ? <= ?
    ON CONFLICT(draft_id, asset_id) DO NOTHING`).bind(row.id, assetId, `drafts/${row.id}/assets/${crypto.randomUUID()}`, bytes.length, hash,
    row.id, principal.id, row.id, bytes.length, DRAFT_LIMITS.draftBytes, principal.id, bytes.length, DRAFT_LIMITS.ownerBytes).run();
  const allocation = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_assets WHERE draft_id = ? AND asset_id = ?').bind(row.id, assetId).first();
  if (!allocation) fail(409, 'DRAFT_QUOTA', 'Draft/owner storage limit reached, or the draft was archived.');
  if (allocation.sha256 !== hash || allocation.byte_length !== bytes.length) fail(409, 'DRAFT_ASSET_CONFLICT', 'A different file is already reserved for this asset. Create a new draft instead of overwriting it.');
  let object = await env.GIZMAGICK_DRAFTS.head(allocation.object_key);
  if (!object) {
    await env.GIZMAGICK_DRAFTS.put(allocation.object_key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: hash,
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' }, customMetadata: { sha256: hash } });
    object = await env.GIZMAGICK_DRAFTS.head(allocation.object_key);
  }
  if (!object || object.size !== bytes.length || object.customMetadata?.sha256 !== hash) fail(503, 'DRAFT_STORAGE', 'Private upload could not be verified. Retry the same file.');
  const saved = await env.GIZMAGICK_DB.prepare(`UPDATE admin_draft_assets SET state = 'uploaded' WHERE draft_id = ? AND asset_id = ?
    AND EXISTS (SELECT 1 FROM admin_drafts WHERE id = ? AND owner_id = ? AND status = 'draft')`).bind(row.id, assetId, row.id, principal.id).run();
  if (!changed(saved)) fail(409, 'DRAFT_ARCHIVED', 'The draft was archived while uploading. Its bytes remain private.');
  return { assetId, byteLength: bytes.length, sha256: hash, uploaded: true, audioProbed: false };
}

export async function handleDraftRequest(request, env, principal, reply, headers) {
  const path = new URL(request.url).pathname;
  const route = path.match(/^\/api\/admin\/drafts\/([^/]+)(?:\/(assets\/([^/]+)|archive|manifest|metadata|review-package|attest-review))?$/);
  if (path !== '/api/admin/drafts' && !route) return null;
  if (!draftsEnabled(env)) return reply({ error: 'Private draft storage is not enabled.', code: 'DRAFT_NOT_CONFIGURED' }, 503);
  try {
    if (route && !UUID_PATTERN.test(route[1])) fail(404, 'DRAFT_NOT_FOUND', 'Draft not found.');
    if (path === '/api/admin/drafts') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const { results } = await env.GIZMAGICK_DB.prepare(`SELECT id, title, status, created_at, updated_at FROM admin_drafts WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).bind(principal.id).all();
        return reply({ drafts: results, limits: DRAFT_LIMITS, publishing: false });
      }
      if (request.method === 'POST') {
        if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'DRAFT_JSON', 'Send application/json.');
        const bytes = await readBoundedBody(request, DRAFT_LIMITS.metadataBytes);
        let input;
        try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'DRAFT_JSON', 'Invalid UTF-8 JSON.'); }
        if (!isObject(input) || !UUID_PATTERN.test(input.requestId || '')) fail(400, 'DRAFT_REQUEST_ID', 'A UUID requestId is required for safe retries.');
        const inputHash = await digest(bytes);
        let existing = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE owner_id = ? AND request_id = ?').bind(principal.id, input.requestId).first();
        if (!existing) {
          const { manifest } = prepareManifest(input);
          const document = JSON.stringify(manifest);
          if (new TextEncoder().encode(document).length > DRAFT_LIMITS.metadataBytes) fail(413, 'DRAFT_TOO_LARGE', 'Converted metadata exceeds the draft limit.');
          const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_drafts (id, owner_id, request_id, input_sha256, title, manifest_json)
            SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM admin_drafts WHERE owner_id = ? AND status = 'draft') < ?
            ON CONFLICT(owner_id, request_id) DO NOTHING`).bind(crypto.randomUUID(), principal.id, input.requestId, inputHash, manifest.track.title, document, principal.id, DRAFT_LIMITS.activeDrafts).run();
          existing = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE owner_id = ? AND request_id = ?').bind(principal.id, input.requestId).first();
          if (!existing) fail(409, 'DRAFT_QUOTA', 'Active draft limit reached. Archive a draft before creating another.');
          if (existing.input_sha256 !== inputHash) fail(409, 'DRAFT_REQUEST_CONFLICT', 'This requestId was already used for different data.');
          return reply(await detail(env, existing), changed(saved) ? 201 : 200);
        }
        if (existing.input_sha256 !== inputHash) fail(409, 'DRAFT_REQUEST_CONFLICT', 'This requestId was already used for different data.');
        return reply(await detail(env, existing));
      }
    } else {
      const row = await ownDraft(env.GIZMAGICK_DB, route[1], principal.id);
      if (!route[2] && ['GET', 'HEAD'].includes(request.method)) return reply(await detail(env, row));
      if (route[2] === 'metadata' && request.method === 'POST') return reply(await updateMetadata(request, env, principal, row));
      if (['review-package', 'attest-review'].includes(route[2])) {
        if (request.method !== 'POST') headers.set('Allow', 'POST');
        return await handleReviewRequest(request, env, principal, row, route[2], reply);
      }
      if (route[2] === 'archive' && request.method === 'POST') {
        await env.GIZMAGICK_DB.prepare(`UPDATE admin_drafts SET status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND owner_id = ?`).bind(row.id, principal.id).run();
        return reply({ id: row.id, status: 'archived', filesDeleted: false });
      }
      if (route[2] === 'manifest' && ['GET', 'HEAD'].includes(request.method)) {
        headers.set('Content-Disposition', 'attachment; filename="draft-manifest.json"');
        return reply(JSON.parse(row.manifest_json));
      }
      if (route[3]) {
        let assetId;
        try { assetId = decodeURIComponent(route[3]); } catch { fail(404, 'DRAFT_ASSET', 'Asset not found.'); }
        if (request.method === 'PUT') return reply(await uploadAsset(request, env, principal, row, assetId));
        if (['GET', 'HEAD'].includes(request.method)) {
          const asset = JSON.parse(row.manifest_json).assets[assetId];
          if (!Object.hasOwn(JSON.parse(row.manifest_json).assets, assetId)) fail(404, 'DRAFT_ASSET', 'Asset not found.');
          const allocation = await env.GIZMAGICK_DB.prepare(`SELECT * FROM admin_draft_assets WHERE draft_id = ? AND asset_id = ? AND state = 'uploaded'`).bind(row.id, assetId).first();
          if (!allocation) fail(404, 'DRAFT_ASSET', 'Asset not uploaded.');
          const object = request.method === 'HEAD' ? await env.GIZMAGICK_DRAFTS.head(allocation.object_key) : await env.GIZMAGICK_DRAFTS.get(allocation.object_key);
          if (!object || object.size !== allocation.byte_length || object.customMetadata?.sha256 !== allocation.sha256) fail(503, 'DRAFT_STORAGE', 'Private file is temporarily unavailable.');
          headers.set('Content-Type', 'application/octet-stream');
          headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(asset.path.slice(6)).replaceAll("'", '%27')}`);
          headers.set('Content-Length', String(object.size));
          return new Response(request.method === 'HEAD' ? null : object.body, { headers });
        }
      }
    }
    headers.set('Allow', path === '/api/admin/drafts' ? 'GET, HEAD, POST' : route?.[3] ? 'GET, HEAD, PUT' : ['archive', 'metadata'].includes(route?.[2]) ? 'POST' : 'GET, HEAD');
    return reply({ error: 'Method not allowed', code: 'DRAFT_METHOD' }, 405);
  } catch (error) {
    if (error instanceof DraftError) return reply({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
    return reply({ error: 'Private drafts are temporarily unavailable.', code: 'DRAFT_UNAVAILABLE' }, 503);
  }
}
