import checkStructure from './generated/manifest-validator.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { libraryVersionLocation } from '../../shared/library-contract.js';
import { REVIEW_POLICY, REVIEW_PACKAGE_BYTES, REVIEW_REPORT_BYTES, checkReviewReport, jsonSha256 } from '../../shared/draft-review.js';
import { snapshotDraft } from './admin-reviews.js';

export const publicationPreflightEnabled = env => env.GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED === 'true'
  && env.GIZMAGICK_DRAFT_UPLOADS_ENABLED === 'true' && env.GIZMAGICK_DRAFT_REVIEWS_ENABLED === 'true'
  && Boolean(env.GIZMAGICK_DB && env.GIZMAGICK_DRAFTS && env.GIZMAGICK_MEDIA)
  && env.GIZMAGICK_DRAFTS !== env.GIZMAGICK_MEDIA;

export class PublicationPreviewError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (code, message, status = 409) => { throw new PublicationPreviewError(status, code, message); };
const validate = manifest => validateManifestWithStructure(manifest, checkStructure);

// This is a point-in-time inspection, NOT a publication permit or write path.
// A later publisher must independently repeat checks and use conditional writes.
export async function inspectReviewedDraft(env, principal, row) {
  if (principal.role !== 'admin') fail('PUBLICATION_PREFLIGHT_ADMIN', 'Only an administrator can inspect publication readiness.', 403);
  if (row.owner_id !== principal.id) fail('DRAFT_NOT_FOUND', 'Draft not found.', 404);
  if (row.status !== 'draft') fail('PUBLICATION_PREFLIGHT_ARCHIVED', 'Archived drafts cannot be prepared for publication.');
  const db = env.GIZMAGICK_DB;
  const review = await db.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first();
  if (!review) fail('PUBLICATION_PREFLIGHT_UNREVIEWED', 'An administrator attestation is required before publication preflight.');
  if (review.storage_check_scope === 'bounded-batches') {
    fail('PUBLICATION_PREFLIGHT_BATCH_REVIEW', 'Batched storage reviews are not supported by this publisher yet. Publishing remains a separate rollout.');
  }
  if (review.policy !== REVIEW_POLICY || review.scope !== 'administrator-attested' || review.approved_by !== principal.id) {
    fail('PUBLICATION_PREFLIGHT_REVIEW', 'The stored review does not match this administrator and policy.');
  }
  const job = await db.prepare('SELECT * FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ?').bind(row.id, review.job_id).first();
  if (!job || new TextEncoder().encode(job.snapshot_json).length > REVIEW_PACKAGE_BYTES
      || new TextEncoder().encode(review.report_json).length > REVIEW_REPORT_BYTES
      || new TextEncoder().encode(review.candidate_json).length > REVIEW_PACKAGE_BYTES) {
    fail('PUBLICATION_PREFLIGHT_REVIEW', 'The stored review package is missing or exceeds its limits.');
  }
  const snapshot = await snapshotDraft(env, row);
  const snapshotHash = await jsonSha256(snapshot);
  const report = JSON.parse(review.report_json), storedSnapshot = JSON.parse(job.snapshot_json);
  if (snapshotHash !== job.snapshot_sha256 || snapshotHash !== review.snapshot_sha256
      || await jsonSha256(storedSnapshot) !== snapshotHash
      || await jsonSha256(snapshot.manifest) !== review.manifest_sha256
      || await jsonSha256(report) !== review.report_sha256) {
    fail('PUBLICATION_PREFLIGHT_CHANGED', 'Reviewed metadata, files, or audit checksums no longer match.');
  }
  // Package expiry gates initial attestation, not an already recorded review.
  // Reconstruct measurements from the exact historical report, never accept a
  // client-supplied candidate or silently claim server-side decoding.
  const checked = await checkReviewReport({ jobId: job.id, snapshotSha256: snapshotHash, snapshot }, report, validate);
  if (!checked.valid || await jsonSha256(checked.candidate) !== await jsonSha256(JSON.parse(review.candidate_json))) {
    fail('PUBLICATION_PREFLIGHT_REVIEW', 'The recorded review candidate could not be reconstructed.');
  }
  const candidate = checked.candidate;
  const location = libraryVersionLocation(env.GIZMAGICK_MEDIA_BASE_URL, candidate.track.id, candidate.versionId);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(candidate)).length;
  const objects = [{ kind: 'manifest', key: location.manifestKey, byteLength: manifestBytes, sha256: await jsonSha256(candidate) },
    ...Object.entries(candidate.assets).map(([id, asset]) => ({ kind: 'audio', assetId: id,
      key: `${location.prefix}/${asset.path}`, byteLength: asset.byteLength, sha256: asset.sha256 }))];
  return { candidate, snapshot, review, job, location, objects, warnings: checked.warnings.slice(0, 30) };
}

export async function requireNewLibraryIdentity(env, candidate) {
  const db = env.GIZMAGICK_DB;
  if (await db.prepare('SELECT id FROM library_tracks WHERE id = ?').bind(candidate.track.id).first()
      || await db.prepare('SELECT version_id FROM library_track_versions WHERE track_id = ? AND version_id = ?')
        .bind(candidate.track.id, candidate.versionId).first()) {
    fail('PUBLICATION_PREFLIGHT_IDENTITY', 'This preview supports new tracks only; the library identity is already reserved.');
  }
}

export async function previewDraftPublication(env, principal, row) {
  if (!publicationPreflightEnabled(env)) fail('PUBLICATION_PREFLIGHT_DISABLED', 'Publication preflight is not enabled.', 503);
  const { candidate, review, objects, warnings } = await inspectReviewedDraft(env, principal, row);
  await requireNewLibraryIdentity(env, candidate);
  for (const object of objects) {
    if (await env.GIZMAGICK_MEDIA.head(object.key)) fail('PUBLICATION_PREFLIGHT_DESTINATION', 'A proposed public object already exists. Nothing will be overwritten.');
  }
  // Detect archival/metadata changes during the sequential storage inspections.
  // This still cannot make D1 + R2 atomic or authorize later work from this reply.
  const current = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!current || current.status !== 'draft' || current.manifest_json !== row.manifest_json) {
    fail('PUBLICATION_PREFLIGHT_CHANGED', 'The draft changed during preflight. Reopen it and try again.');
  }
  return { previewVersion: 1, draftId: row.id, trackId: candidate.track.id, versionId: candidate.versionId,
    ownerId: principal.id, checksPassed: true, pointInTimeOnly: true, publicationAuthorized: false,
    publishing: false, serverDecoded: false, scope: review.scope,
    review: { policy: review.policy, approvedAt: review.approved_at, reportSha256: review.report_sha256,
      snapshotSha256: review.snapshot_sha256 }, objects, warnings };
}
