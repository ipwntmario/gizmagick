import { ORIGINAL_LIBRARY } from '../../shared/original-library.js';
import { jsonSha256 } from '../../shared/draft-review.js';
import { DraftError } from './admin-drafts.js';
import { requireNewLibraryIdentity } from './admin-publication-preview.js';
import { calculateJsonOnce } from './admin-json-cache.js';

export const originalPublicationEnabled = env => env.GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED === 'true';
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
export const originalMapping = row => ({ legacyKey: row.legacy_key, sourceVersionId: row.source_version_id,
  sourceManifestSha256: row.source_manifest_sha256 });

// Current authority, not just a historical intake record. The SQL view requires
// the exact owner's private, unpublished reservation and no existing versions.
export async function publicationIdentity(env, principal, row, candidate) {
  if (!row.original_legacy_key) { await requireNewLibraryIdentity(env, candidate); return null; }
  if (!originalPublicationEnabled(env)) fail(409, 'ORIGINAL_PRIVATE_ONLY', 'Publication of preserved original identities is disabled.');
  const installed = await env.GIZMAGICK_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'admin_original_publication_guard'").first();
  if (!installed) fail(503, 'ORIGINAL_PUBLICATION_SCHEMA', 'Original publication requires migration 0011 before preparation or copying.');
  const identity = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_original_publication_identity WHERE draft_id = ?').bind(row.id).first();
  const pinned = ORIGINAL_LIBRARY.find(item => item.legacyKey === row.original_legacy_key);
  if (principal.role !== 'admin' || !identity || !pinned || identity.owner_id !== principal.id || row.owner_id !== principal.id
      || identity.track_id !== candidate.track.id || pinned.trackId !== candidate.track.id
      || identity.legacy_key !== row.original_legacy_key || identity.source_version_id !== pinned.sourceVersionId
      || identity.source_manifest_sha256 !== pinned.sourceManifestSha256
      || await calculateJsonOnce(['original-source-hash-v1', identity.source_manifest_json], () => jsonSha256(JSON.parse(identity.source_manifest_json))) !== pinned.sourceManifestSha256) {
    fail(409, 'ORIGINAL_PUBLICATION_IDENTITY', 'Original source, owner/key mapping or private unpublished identity no longer matches. Existing published tracks cannot be revised here.');
  }
  return originalMapping(identity);
}
