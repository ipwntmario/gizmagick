import { ORIGINAL_LIBRARY } from '../../shared/original-library.js';
import { UUID_PATTERN } from '../../shared/library-contract.js';
import { jsonSha256 } from '../../shared/draft-review.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import checkStructure from './generated/manifest-validator.js';
import { DRAFT_LIMITS, DraftError, draftDetail, draftsEnabled, readBoundedBody } from './admin-drafts.js';

export const originalImportsEnabled = env => draftsEnabled(env) && env.GIZMAGICK_ORIGINAL_IMPORTS_ENABLED === 'true';
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const findRequest = (db, owner, id) => db.prepare('SELECT * FROM admin_drafts WHERE owner_id = ? AND request_id = ?').bind(owner, id).first();

async function recover(env, principal, input, inputHash) {
  const row = await findRequest(env.GIZMAGICK_DB, principal.id, input.requestId);
  if (!row) return null;
  const provenance = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_original_imports WHERE draft_id = ?').bind(row.id).first();
  if (row.input_sha256 !== inputHash || row.original_legacy_key !== input.legacyKey
      || !provenance || provenance.owner_id !== principal.id) {
    fail(409, 'ORIGINAL_REQUEST_CONFLICT', 'This request ID was already used for different data or a different workflow.');
  }
  return draftDetail(env, row);
}

async function importOriginal(request, env, principal) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'ORIGINAL_JSON', 'Send application/json.');
  const bytes = await readBoundedBody(request, DRAFT_LIMITS.metadataBytes);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'ORIGINAL_JSON', 'Invalid UTF-8 JSON.'); }
  const keys = ['requestId', 'legacyKey', 'expectedOwnerId', 'sourceManifest', 'importConfirmed'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
      || typeof input.requestId !== 'string' || !UUID_PATTERN.test(input.requestId) || input.importConfirmed !== true) {
    fail(400, 'ORIGINAL_INPUT', 'Supply the original key, source manifest, UUID request ID and explicit private-import confirmation.');
  }
  if (input.expectedOwnerId !== principal.id) fail(403, 'ORIGINAL_OWNER', 'The expected owner must match this verified administrator. Ownership cannot be supplied by a manifest.');
  const identity = ORIGINAL_LIBRARY.find(item => item.legacyKey === input.legacyKey);
  const source = input.sourceManifest;
  if (!identity || source?.track?.id !== identity.trackId || source?.versionId !== identity.sourceVersionId
      || await jsonSha256(source) !== identity.sourceManifestSha256) {
    fail(422, 'ORIGINAL_SOURCE', 'Select the exact pinned original manifest for this catalog key. Changed source snapshots need a separately reviewed allowlist update.');
  }
  const validation = validateManifestWithStructure(source, checkStructure);
  if (!validation.valid || Object.keys(source.assets).length > DRAFT_LIMITS.assets
      || Object.keys(source.clips).length > DRAFT_LIMITS.clips || Object.keys(source.sections).length > DRAFT_LIMITS.sections
      || Object.values(source.assets).some(asset => !Number.isSafeInteger(asset.byteLength)
        || asset.byteLength < 1 || asset.byteLength > DRAFT_LIMITS.audioBytes || !/^[a-f0-9]{64}$/.test(asset.sha256))
      || Object.values(source.assets).reduce((sum, asset) => sum + asset.byteLength, 0) > DRAFT_LIMITS.draftBytes) {
    fail(422, 'ORIGINAL_MANIFEST', 'Original metadata must satisfy graph, fingerprint and private-draft limits.');
  }
  const inputHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const recovered = await recover(env, principal, input, inputHash);
  if (recovered) return { draft: recovered, status: 200 };
  const draftId = crypto.randomUUID(), manifest = structuredClone(source);
  manifest.versionId = crypto.randomUUID();
  const db = env.GIZMAGICK_DB;
  // D1 batch is transactional. Uniqueness, quota and provenance guards must all
  // pass; a failed later INSERT cannot leave behind a private identity/draft.
  try {
    await db.batch([
      db.prepare('INSERT INTO library_tracks (id, legacy_key, owner_id) VALUES (?, ?, ?)').bind(identity.trackId, identity.legacyKey, principal.id),
      db.prepare(`INSERT INTO admin_drafts (id, owner_id, request_id, input_sha256, title, manifest_json, original_legacy_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(draftId, principal.id, input.requestId, inputHash, manifest.track.title, JSON.stringify(manifest), identity.legacyKey),
      db.prepare(`INSERT INTO admin_original_imports (draft_id, track_id, legacy_key, owner_id, source_version_id, source_manifest_sha256, source_manifest_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(draftId, identity.trackId, identity.legacyKey, principal.id, source.versionId, identity.sourceManifestSha256, JSON.stringify(source)),
    ]);
  } catch {
    // A concurrent identical request may have completed. Never blindly retry the
    // batch, adopt an existing library row or reveal another owner's records.
    const concurrent = await recover(env, principal, input, inputHash);
    if (concurrent) return { draft: concurrent, status: 200 };
    fail(409, 'ORIGINAL_CONFLICT', 'Import could not be confirmed: identity/key reservation, conflicting draft/intent, or active draft limit. Refresh drafts before retrying this exact request. No public files were written.');
  }
  const row = await findRequest(db, principal.id, input.requestId);
  return { draft: await draftDetail(env, row), status: 201 };
}

export async function handleOriginalImportRequest(request, env, principal, reply, headers) {
  if (new URL(request.url).pathname !== '/api/admin/original-imports') return null;
  if (!originalImportsEnabled(env)) return reply({ code: 'ORIGINAL_DISABLED', error: 'Original-library private intake is not enabled.' }, 503);
  if (principal.role !== 'admin' || !/^access:[a-f0-9]{64}$/.test(principal.id)) return reply({ code: 'ORIGINAL_ADMIN', error: 'A verified administrator is required.' }, 403);
  try {
    // Fail before any writes if migration 0010 was not installed.
    await env.GIZMAGICK_DB.prepare('SELECT draft_id FROM admin_original_imports LIMIT 1').first();
    if (['GET', 'HEAD'].includes(request.method)) return reply({ originals: ORIGINAL_LIBRARY, expectedOwnerId: principal.id, publishing: false, publicStorageChecked: false });
    if (request.method !== 'POST') {
      headers.set('Allow', 'GET, HEAD, POST');
      return reply({ code: 'ORIGINAL_METHOD', error: 'Method not allowed.' }, 405);
    }
    const result = await importOriginal(request, env, principal);
    return reply(result.draft, result.status);
  } catch (error) {
    if (error instanceof DraftError) return reply({ code: error.code, error: error.message }, error.status);
    return reply({ code: 'ORIGINAL_UNAVAILABLE', error: 'Original-library private intake is temporarily unavailable. Refresh drafts before retrying the same request.' }, 503);
  }
}
