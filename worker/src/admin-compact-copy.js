import { DraftError } from './admin-drafts.js';
import { copyOne, PUBLICATION_LIMITS } from './admin-publications.js';
import { inspectAllocationAssets } from './admin-storage-inspection.js';
import { normalizeMediaBase } from '../../shared/library-contract.js';
import { ORIGINAL_LIBRARY } from '../../shared/original-library.js';
import { publicationIdentity } from './admin-original-publication.js';

const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);

// Reservation already validated and hashed the complete plan. Both identical
// copies (preparation and intent) are retained behind immutable SQL triggers.
// Recheck current authority INSIDE D1, without transferring those large JSON
// documents through the Worker for every file. This is never a cached decision.
const retainedPlan = `EXISTS (SELECT 1 FROM admin_publication_intent_preparations q
  WHERE q.id = p.id AND q.draft_id = p.draft_id AND q.owner_id = p.owner_id
    AND q.plan_sha256 = p.plan_sha256 AND q.plan_json = p.plan_json)`;
const authority = `${retainedPlan} AND p.state = 'pending'
  AND json_extract(p.plan_json, '$.planVersion') = 2
  AND json_extract(p.plan_json, '$.mediaBase') = ?
  AND EXISTS (SELECT 1 FROM admin_drafts d JOIN admin_draft_reviews r ON r.draft_id = d.id
    JOIN admin_draft_review_jobs j ON j.draft_id = d.id AND j.id = r.job_id
    WHERE d.id = p.draft_id AND d.owner_id = p.owner_id AND d.status = 'draft'
      AND d.manifest_json = json_extract(p.plan_json, '$.manifestJson')
      AND r.approved_by = p.owner_id AND r.policy = 'gizmagick-local-admin-v1' AND r.scope = 'administrator-attested'
      AND r.job_id = json_extract(p.plan_json, '$.review.jobId')
      AND r.snapshot_sha256 = json_extract(p.plan_json, '$.review.snapshotSha256') AND j.snapshot_sha256 = r.snapshot_sha256
      AND j.snapshot_json = json_extract(p.plan_json, '$.snapshotJson')
      AND r.manifest_sha256 = json_extract(p.plan_json, '$.review.manifestSha256')
      AND r.report_sha256 = json_extract(p.plan_json, '$.review.reportSha256')
      AND r.report_json = json_extract(p.plan_json, '$.reportJson') AND r.candidate_json = json_extract(p.plan_json, '$.candidateJson')
      AND r.storage_check_scope = json_extract(p.plan_json, '$.review.storageCheckScope')
      AND r.storage_verification_id IS json_extract(p.plan_json, '$.review.storageAudit.verificationId')
      AND r.storage_checked_from IS json_extract(p.plan_json, '$.review.storageAudit.checkedFrom')
      AND r.storage_checked_until IS json_extract(p.plan_json, '$.review.storageAudit.checkedUntil')
      AND (r.storage_check_scope = 'single-request' OR (r.storage_check_scope = 'bounded-batches'
        AND unixepoch(r.approved_at) IS NOT NULL
        AND EXISTS (SELECT 1 FROM admin_draft_review_verifications v
          JOIN admin_publication_intent_preparations q ON q.id = p.id
          WHERE v.id = r.storage_verification_id AND v.draft_id = d.id AND v.owner_id = p.owner_id
            AND v.job_id = j.id AND v.report_sha256 = r.report_sha256 AND v.report_json = r.report_json
            AND v.snapshot_sha256 = r.snapshot_sha256 AND v.allocation_sha256 = q.allocation_sha256)
        AND (SELECT COUNT(*) FROM admin_draft_review_verification_batches b WHERE b.verification_id = r.storage_verification_id)
          = (json_array_length(p.plan_json, '$.sources') + 15) / 16
        AND NOT EXISTS (SELECT 1 FROM admin_draft_review_verification_batches b WHERE b.verification_id = r.storage_verification_id
          AND (b.offset >= json_array_length(p.plan_json, '$.sources')
            OR b.end_offset != MIN(b.offset + 16, json_array_length(p.plan_json, '$.sources'))
            OR b.checked_at < unixepoch(r.approved_at) - 300 OR b.checked_at > unixepoch(r.approved_at)))
        AND r.storage_checked_from = (SELECT MIN(checked_at) FROM admin_draft_review_verification_batches WHERE verification_id = r.storage_verification_id)
        AND r.storage_checked_until = (SELECT MAX(checked_at) FROM admin_draft_review_verification_batches WHERE verification_id = r.storage_verification_id))))
  AND EXISTS (SELECT 1 FROM admin_publication_identity_authority WHERE publication_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = p.track_id)
  AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = p.draft_id) = json_array_length(p.plan_json, '$.sources')
  AND NOT EXISTS (SELECT 1 FROM json_each(p.plan_json, '$.sources') s WHERE NOT EXISTS (
    SELECT 1 FROM admin_draft_assets a WHERE a.draft_id = p.draft_id AND a.state = 'uploaded'
      AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
      AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256')))`;

async function schema(env) {
  const names = ['admin_bounded_copy_guard', 'admin_publication_intent_immutable',
    'admin_intent_preparation_retained_update', 'admin_intent_preparation_retained_delete',
    'admin_publication_no_delete', 'admin_original_import_immutable_update', 'admin_original_import_immutable_delete',
    'admin_batched_review_retained_update', 'admin_review_verification_retained_update',
    'admin_review_verification_batch_retained_update', 'admin_publication_identity_authority'];
  const { results } = await env.GIZMAGICK_DB.prepare(`SELECT name FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`).bind(...names).all();
  if (results.length !== names.length) fail(503, 'INTENT_COPY_SCHEMA', 'Compact copying requires the retained intent and original-identity guards. No copy was attempted.');
}

async function summary(env, row) {
  const saved = await env.GIZMAGICK_DB.prepare(`SELECT p.id, p.state, p.plan_sha256, p.track_id, p.version_id,
    json_extract(p.plan_json, '$.planVersion') plan_version,
    json_array_length(p.plan_json, '$.objects') total,
    json_extract(p.plan_json, '$.originalImport') original_json,
    json_extract(p.plan_json, '$.review.storageCheckScope') review_scope,
    ${retainedPlan} retained,
    (SELECT COUNT(*) FROM admin_publication_objects WHERE publication_id = p.id) copied,
    (SELECT MIN(ordinal) FROM admin_publication_objects WHERE publication_id = p.id) first_ordinal,
    (SELECT MAX(ordinal) FROM admin_publication_objects WHERE publication_id = p.id) last_ordinal,
    (SELECT published_at FROM admin_publication_commits WHERE publication_id = p.id) published_at
    FROM admin_publications p WHERE p.draft_id = ? AND p.owner_id = ?`).bind(row.id, row.owner_id).first();
  if (!saved || saved.plan_version !== 2) return null;
  if (!saved.retained || saved.total < 2 || saved.total > 257 || saved.copied > saved.total
      || (saved.copied && (saved.first_ordinal !== 0 || saved.last_ordinal !== saved.copied - 1))) fail(409, 'INTENT_PROGRESS', 'The retained plan or contiguous copy progress changed. No continuation is permitted.');
  return saved;
}

function responseFor(saved, row, enabled) {
  const canCopy = enabled && row.status === 'draft' && saved.state === 'pending' && saved.copied < saved.total;
  return { workflowVersion: 2, publishing: false, publicCopyEnabled: enabled, catalogCommitEnabled: false,
    publicationAuthorized: false, serverDecoded: false, pointInTimeBatches: true, preparation: null, legacyPublication: null,
    intent: { id: saved.id, draftId: row.id, trackId: saved.track_id, versionId: saved.version_id,
      planSha256: saved.plan_sha256, state: saved.state, publishedAt: saved.published_at ?? null,
      copiedObjects: saved.copied, totalObjects: saved.total, nextAction: canCopy ? 'copy-one-object' : null,
      continuationBlocked: !canCopy, storageCheckScope: saved.review_scope,
      ...(saved.original_json ? { originalImport: JSON.parse(saved.original_json) } : {}) } };
}

export async function compactIntentStatus(env, row, enabled) {
  await schema(env);
  const saved = await summary(env, row);
  return saved ? responseFor(saved, row, enabled) : null;
}

export async function copyCompactIntent(env, principal, row, input, reply, enabled) {
  if (!enabled) fail(503, 'INTENT_COPY_DISABLED', 'Bounded public copying is disabled. Existing public bytes are not removed.');
  if (principal.role !== 'admin') fail(403, 'INTENT_ADMIN', 'Only a verified administrator may copy their own reviewed plan.');
  if (row.owner_id !== principal.id) fail(404, 'INTENT_NOT_FOUND', 'Draft not found.');
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 256 || input.publicationConfirmed !== true) fail(400, 'INTENT_INPUT', 'Confirm one exact object number.');
  await schema(env);
  const saved = await summary(env, row);
  if (!saved || saved.id !== input.publicationId) fail(404, 'INTENT_NOT_FOUND', 'The exact publication intent was not found.');
  if (saved.state !== 'pending' || saved.plan_sha256 !== input.expectedPlanSha256 || input.ordinal >= saved.total) fail(409, 'INTENT_COPY_PLAN', 'Use the exact pending intent, plan checksum and object number.');
  const db = env.GIZMAGICK_DB, mediaBase = normalizeMediaBase(env.GIZMAGICK_MEDIA_BASE_URL);
  const identity = row.original_legacy_key ? ORIGINAL_LIBRARY.find(item => item.legacyKey === row.original_legacy_key) : null;
  if (row.original_legacy_key && !identity) fail(409, 'ORIGINAL_PUBLICATION_IDENTITY', 'Original mapping is not recognized.');
  // Preserve the independent pinned-source checksum check for originals; only
  // its deterministic calculation is reused for identical source text.
  if (identity) await publicationIdentity(env, principal, row, { track: { id: saved.track_id }, versionId: saved.version_id });
  const pinned = row.original_legacy_key ? ` AND EXISTS (SELECT 1 FROM admin_original_publication_identity i
    WHERE i.draft_id = p.draft_id AND i.owner_id = p.owner_id AND i.track_id = ? AND i.source_version_id = ? AND i.source_manifest_sha256 = ?)` : '';
  const identityArgs = identity ? [identity.trackId, identity.sourceVersionId, identity.sourceManifestSha256] : [];
  const args = [saved.id, row.id, principal.id, saved.plan_sha256, mediaBase, ...identityArgs];
  const where = `p.id = ? AND p.draft_id = ? AND p.owner_id = ? AND p.plan_sha256 = ? AND ${authority}${pinned}`;
  // JSON paths contain only the already range-checked integer ordinal.
  const objectPath = `$.objects[${input.ordinal}]`;
  const selected = await db.prepare(`SELECT json_extract(p.plan_json, ?) object_json,
    (SELECT value FROM json_each(p.plan_json, '$.sources') s
      WHERE json_extract(s.value, '$.assetId') = json_extract(p.plan_json, ? || '.assetId')) source_json,
    CASE WHEN json_extract(p.plan_json, ? || '.kind') = 'manifest' THEN json_extract(p.plan_json, '$.candidateJson') END candidate_json
    FROM admin_publications p WHERE ${where}`).bind(objectPath, objectPath, objectPath, ...args).first();
  if (!selected) fail(409, 'INTENT_CHANGED', 'The current approval, allocations, retained plan or original identity changed. Refresh status.');
  if (input.ordinal < saved.copied) return reply(responseFor(saved, row, enabled));
  if (input.ordinal !== saved.copied) fail(409, 'INTENT_COPY_ORDER', 'Only the next unrecorded object may be copied. Refresh status.');
  const token = crypto.randomUUID();
  const locked = await db.prepare(`UPDATE admin_publications SET lease_token = ?, lease_expires_at = unixepoch('now') + ?
    WHERE id = ? AND owner_id = ? AND state = 'pending' AND lease_expires_at <= unixepoch('now')`)
    .bind(token, PUBLICATION_LIMITS.leaseSeconds, saved.id, principal.id).run();
  if (!changed(locked)) fail(409, 'INTENT_COPY_BUSY', 'Another copy is running. Refresh status; interrupted leases expire after two minutes.');
  try {
    const checkLease = async () => {
      const valid = await db.prepare(`SELECT p.id FROM admin_publications p WHERE ${where}
        AND p.lease_token = ? AND p.lease_expires_at > unixepoch('now')`).bind(...args, token).first();
      if (!valid) fail(409, 'INTENT_COPY_CHANGED', 'The lease, current approval, allocations or identity changed. Bytes may already be public; refresh status.');
    };
    await checkLease();
    const latest = await summary(env, row);
    if (input.ordinal < latest.copied) return reply(responseFor(latest, row, enabled));
    if (input.ordinal !== latest.copied) fail(409, 'INTENT_COPY_ORDER', 'Copy progress changed. Refresh status.');
    const object = JSON.parse(selected.object_json), source = selected.source_json ? JSON.parse(selected.source_json) : null;
    if (object.kind === 'audio') {
      const [actual] = await inspectAllocationAssets(env, [source]);
      if (actual.etag !== source.etag) fail(409, 'INTENT_COPY_SOURCE', 'This private file changed since its administrator review.');
    }
    const objects = []; objects[input.ordinal] = object;
    await copyOne(env, row, { id: saved.id, plan_sha256: saved.plan_sha256 }, {
      planVersion: 2, objects, sources: source ? [source] : [],
      candidate: selected.candidate_json ? JSON.parse(selected.candidate_json) : undefined,
    }, token, input.ordinal, checkLease);
    return reply(responseFor(await summary(env, row), row, enabled));
  } catch (error) {
    if (String(error.message).includes('Bounded copy changed before receipt')) fail(409, 'INTENT_COPY_CHANGED', 'The receipt was rejected because current authority changed. Bytes may already be public; refresh status.');
    throw error;
  } finally {
    await db.prepare("UPDATE admin_publications SET lease_token = NULL, lease_expires_at = 0 WHERE id = ? AND state = 'pending' AND lease_token = ?").bind(saved.id, token).run();
  }
}
