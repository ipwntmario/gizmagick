import checkStructure from './generated/manifest-validator.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { UUID_PATTERN, libraryVersionLocation, normalizeMediaBase } from '../../shared/library-contract.js';
import { REVIEW_POLICY, REVIEW_PACKAGE_BYTES, REVIEW_REPORT_BYTES, checkReviewReport, jsonSha256 } from '../../shared/draft-review.js';
import { DraftError, readBoundedBody } from './admin-drafts.js';
import { allocationSnapshot, inspectAllocationAssets } from './admin-storage-inspection.js';
import { publicationPreflightEnabled } from './admin-publication-preview.js';
import { originalPublicationEnabled, publicationIdentity } from './admin-original-publication.js';
import { copyOne, publishingEnabled, PUBLICATION_LIMITS } from './admin-publications.js';
import { calculateJsonOnce } from './admin-json-cache.js';

export const publicationIntentsEnabled = env => publicationPreflightEnabled(env) && env.GIZMAGICK_PUBLICATION_INTENTS_ENABLED === 'true';
export const boundedCopyEnabled = env => publicationIntentsEnabled(env) && publishingEnabled(env) && env.GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED === 'true';
export const INTENT_LIMITS = Object.freeze({ assets: 256, batch: 16, planBytes: 1048576, inputBytes: 2048, lifetime: 900, freshness: 300 });
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && UUID_PATTERN.test(value);
const validate = manifest => validateManifestWithStructure(manifest, checkStructure);
const existingIntent = (env, row) => env.GIZMAGICK_DB.prepare('SELECT * FROM admin_publications WHERE draft_id = ? AND owner_id = ?').bind(row.id, row.owner_id).first();
const preparationFor = (env, row) => env.GIZMAGICK_DB.prepare("SELECT *, expires_at > unixepoch('now') AS unexpired FROM admin_publication_intent_preparations WHERE draft_id = ?").bind(row.id).first();

// Exact attested record reconstruction, without reading all private objects.
// Each selected source and proposed destination is independently HEAD-checked later.
export async function reviewedIntentPlan(env, principal, row) {
  if (row.status !== 'draft' || row.owner_id !== principal.id) fail(409, 'INTENT_DRAFT', 'Only your active, reviewed draft can prepare an intent.');
  const review = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first();
  if (!review || review.approved_by !== principal.id || review.policy !== REVIEW_POLICY || review.scope !== 'administrator-attested') fail(409, 'INTENT_REVIEW', 'This exact administrator attestation is required.');
  const job = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ?').bind(row.id, review.job_id).first();
  if (!job || new TextEncoder().encode(job.snapshot_json).length > REVIEW_PACKAGE_BYTES
      || new TextEncoder().encode(review.report_json).length > REVIEW_REPORT_BYTES
      || new TextEncoder().encode(review.candidate_json).length > REVIEW_PACKAGE_BYTES) fail(409, 'INTENT_REVIEW', 'The bounded review record is missing or too large.');
  const allocation = await allocationSnapshot(env, row);
  const documents = await calculateJsonOnce(['review-documents-v1', job.id, job.snapshot_sha256, job.snapshot_json, review.report_json, review.candidate_json], async () => {
    const snapshot = JSON.parse(job.snapshot_json), report = JSON.parse(review.report_json);
    const checked = await checkReviewReport({ jobId: job.id, snapshotSha256: job.snapshot_sha256, snapshot }, report, validate);
    return { snapshot, checked, snapshotHash: await jsonSha256(snapshot), manifestHash: await jsonSha256(snapshot.manifest),
      reportHash: await jsonSha256(report), candidateMatches: checked.valid && await jsonSha256(checked.candidate) === await jsonSha256(JSON.parse(review.candidate_json)) };
  });
  const { snapshot, checked } = documents;
  if (!snapshot || snapshot.draftId !== row.id || documents.snapshotHash !== job.snapshot_sha256
      || job.snapshot_sha256 !== review.snapshot_sha256 || documents.manifestHash !== review.manifest_sha256
      || allocation.manifestSha256 !== review.manifest_sha256 || documents.reportHash !== review.report_sha256
      || !Array.isArray(snapshot.assets) || snapshot.assets.length !== allocation.assets.length
      || snapshot.assets.some((source, index) => {
        const asset = allocation.assets[index];
        return source.assetId !== asset.assetId || source.path !== asset.path || source.objectKey !== asset.objectKey
          || source.byteLength !== asset.byteLength || source.sha256 !== asset.sha256 || typeof source.etag !== 'string' || !source.etag;
      })) fail(409, 'INTENT_CHANGED', 'Reviewed metadata, allocations or fingerprints no longer match.');
  const scope = review.storage_check_scope || 'single-request';
  if (!['single-request', 'bounded-batches'].includes(scope)) fail(409, 'INTENT_REVIEW', 'Unsupported storage review scope.');
  let storageAudit = null;
  if (scope === 'bounded-batches') {
    const verification = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_review_verifications WHERE draft_id = ? AND id = ?').bind(row.id, review.storage_verification_id).first();
    const { results: checks } = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_review_verification_batches WHERE verification_id = ? ORDER BY offset LIMIT 17').bind(review.storage_verification_id).all();
    const approved = Math.floor(Date.parse(review.approved_at) / 1000);
    if (!verification || !Number.isSafeInteger(approved) || verification.owner_id !== principal.id || verification.job_id !== job.id
        || verification.report_sha256 !== review.report_sha256 || verification.report_json !== review.report_json
        || verification.snapshot_sha256 !== review.snapshot_sha256 || verification.allocation_sha256 !== allocation.sha256
        || checks.length !== Math.ceil(snapshot.assets.length / 16)
        || checks.some((check, index) => check.offset !== index * 16 || check.end_offset !== Math.min(index * 16 + 16, snapshot.assets.length)
          || check.checked_at < approved - 300 || check.checked_at > approved)
        || Math.min(...checks.map(check => check.checked_at)) !== review.storage_checked_from
        || Math.max(...checks.map(check => check.checked_at)) !== review.storage_checked_until) fail(409, 'INTENT_REVIEW', 'The recorded separate-batch review evidence is incomplete or inconsistent.');
    storageAudit = { verificationId: verification.id, checkedFrom: review.storage_checked_from, checkedUntil: review.storage_checked_until };
  }
  if (!checked.valid || !documents.candidateMatches) fail(409, 'INTENT_REVIEW', 'The exact measured review candidate could not be reconstructed.');
  const candidate = checked.candidate, mediaBase = normalizeMediaBase(env.GIZMAGICK_MEDIA_BASE_URL);
  const originalImport = await publicationIdentity(env, principal, row, candidate);
  const reviewIdentity = { jobId: review.job_id, policy: review.policy, scope: review.scope, snapshotSha256: review.snapshot_sha256,
    reportSha256: review.report_sha256, manifestSha256: review.manifest_sha256, storageCheckScope: scope, storageAudit };
  // All mutable authority and allocation/audit checks above still run per request.
  // Only assembly/hashing of an exactly identical JSON plan is reusable.
  const assembled = await calculateJsonOnce(['reviewed-plan-v1', row.id, principal.id, mediaBase, row.manifest_json,
    review.candidate_json, job.snapshot_json, review.report_json, JSON.stringify(reviewIdentity), JSON.stringify(originalImport)], async () => {
    const location = libraryVersionLocation(mediaBase, candidate.track.id, candidate.versionId);
    const objects = [...Object.entries(candidate.assets).map(([assetId, asset]) => ({ kind: 'audio', assetId,
      key: `${location.prefix}/${asset.path}`, byteLength: asset.byteLength, sha256: asset.sha256 })),
    { kind: 'manifest', key: location.manifestKey, byteLength: new TextEncoder().encode(JSON.stringify(candidate)).length, sha256: await jsonSha256(candidate) }];
    const plan = { planVersion: 2, workflow: originalImport ? 'bounded-original-track' : 'bounded-new-track',
      ...(originalImport ? { originalImport } : {}), draftId: row.id, ownerId: principal.id,
      mediaBase, manifestJson: row.manifest_json, candidate, candidateJson: review.candidate_json,
      snapshotJson: job.snapshot_json, reportJson: review.report_json, sources: snapshot.assets,
      review: reviewIdentity, objects, warnings: checked.warnings.slice(0, 30) };
    if (new TextEncoder().encode(JSON.stringify(plan)).length > INTENT_LIMITS.planBytes) fail(413, 'INTENT_SIZE', 'The publication plan exceeds its metadata limit.');
    return { plan, planHash: await jsonSha256(plan) };
  });
  return { ...assembled, allocation };
}

// Same database predicates fence preparation/batch/intent writes. No storage
// read receipt can change ownership, identities, review policy or public pointers.
const reviewGuard = `EXISTS (SELECT 1 FROM admin_drafts d JOIN admin_draft_reviews r ON r.draft_id = d.id
  JOIN admin_draft_review_jobs j ON j.draft_id = d.id AND j.id = r.job_id WHERE d.id = ? AND d.owner_id = ? AND d.status = 'draft'
  AND d.manifest_json = ? AND r.approved_by = ? AND r.policy = 'gizmagick-local-admin-v1' AND r.scope = 'administrator-attested'
  AND r.job_id = ? AND r.snapshot_sha256 = ? AND r.report_sha256 = ? AND r.manifest_sha256 = ?
  AND r.report_json = ? AND r.candidate_json = ? AND j.snapshot_json = ? AND j.snapshot_sha256 = r.snapshot_sha256
  AND r.storage_check_scope = ? AND r.storage_verification_id IS ? AND r.storage_checked_from IS ? AND r.storage_checked_until IS ?)
  AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = ?) = ?
  AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM admin_draft_assets a WHERE a.draft_id = ?
    AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
    AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256') AND a.state = 'uploaded'))`;
export const guard = checked => `${reviewGuard} AND ${checked.plan.originalImport
  ? `EXISTS (SELECT 1 FROM admin_original_publication_identity WHERE draft_id = ? AND owner_id = ? AND track_id = ?
      AND legacy_key = ? AND source_version_id = ? AND source_manifest_sha256 = ?)`
  : 'NOT EXISTS (SELECT 1 FROM library_tracks WHERE id = ?)'}
  AND NOT EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = ?)`;
export const guardArgs = (row, checked) => {
  const { plan, allocation } = checked, review = plan.review, audit = review.storageAudit;
  return [row.id, row.owner_id, row.manifest_json, row.owner_id, review.jobId, review.snapshotSha256, review.reportSha256,
    review.manifestSha256, plan.reportJson, plan.candidateJson, plan.snapshotJson, review.storageCheckScope,
    audit?.verificationId ?? null, audit?.checkedFrom ?? null, audit?.checkedUntil ?? null, row.id, allocation.assets.length,
    JSON.stringify(allocation.assets), row.id, ...(plan.originalImport
      ? [row.id, row.owner_id, plan.candidate.track.id, plan.originalImport.legacyKey, plan.originalImport.sourceVersionId, plan.originalImport.sourceManifestSha256]
      : [plan.candidate.track.id]), plan.candidate.track.id];
};

async function batchesFor(env, prep) {
  const { results } = await env.GIZMAGICK_DB.prepare(`SELECT *, checked_at BETWEEN unixepoch('now') - 300 AND unixepoch('now') AS recent
    FROM admin_publication_intent_batches WHERE preparation_id = ? ORDER BY offset LIMIT 18`).bind(prep.id).all();
  let end = 0;
  for (const batch of results) { if (batch.offset !== end) fail(409, 'INTENT_PROGRESS', 'Intent-check progress is inconsistent. Restart preparation.'); end = batch.end_offset; }
  return { end, results, recent: results.every(batch => batch.recent) };
}
export async function checkedStored(prep) {
  const stored = await calculateJsonOnce(['stored-intent-v1', prep.plan_json], async () => {
    if (new TextEncoder().encode(prep.plan_json).length > INTENT_LIMITS.planBytes) fail(409, 'INTENT_PLAN', 'Stored plan exceeds its limit.');
    const plan = JSON.parse(prep.plan_json);
    return { plan, hash: await jsonSha256(plan) };
  });
  const { plan } = stored;
  if (stored.hash !== prep.plan_sha256 || plan.planVersion !== 2 || plan.draftId !== prep.draft_id || plan.ownerId !== prep.owner_id
      || !['bounded-new-track', 'bounded-original-track'].includes(plan.workflow)
      || (plan.workflow === 'bounded-new-track' ? Object.hasOwn(plan, 'originalImport')
        : !plan.originalImport || Object.keys(plan.originalImport).sort().join(',') !== 'legacyKey,sourceManifestSha256,sourceVersionId'
          || typeof plan.originalImport.legacyKey !== 'string' || !uuid(plan.originalImport.sourceVersionId) || !sha(plan.originalImport.sourceManifestSha256))
      || !Array.isArray(plan.objects) || plan.objects.length < 2 || plan.objects.length > 257
      || (prep.track_id && (plan.candidate.track.id !== prep.track_id || plan.candidate.versionId !== prep.version_id))) fail(409, 'INTENT_PLAN', 'Stored intent plan does not match its checksum or identity.');
  return plan;
}
async function copySchema(env) {
  const installed = await env.GIZMAGICK_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'admin_bounded_copy_guard'").first();
  if (!installed) fail(503, 'INTENT_COPY_SCHEMA', 'Bounded copying needs migration 0008 before it can be enabled. No public copy was attempted.');
}
export async function copyProgress(env, intent, plan) {
  const { results } = await env.GIZMAGICK_DB.prepare('SELECT ordinal, etag FROM admin_publication_objects WHERE publication_id = ? ORDER BY ordinal LIMIT 258').bind(intent.id).all();
  if (results.length > plan.objects.length || results.some((receipt, index) => receipt.ordinal !== index || !receipt.etag)) fail(409, 'INTENT_PROGRESS', 'Stored public-copy progress is inconsistent. No continuation is permitted.');
  return results;
}
async function statusFor(env, row) {
  const intent = await existingIntent(env, row);
  const enabled = boundedCopyEnabled(env) && (!row.original_legacy_key || originalPublicationEnabled(env));
  if (enabled) await copySchema(env);
  const flags = { workflowVersion: 2, publishing: false, publicCopyEnabled: enabled, catalogCommitEnabled: false,
    publicationAuthorized: false, serverDecoded: false, pointInTimeBatches: true };
  if (intent) {
    const raw = JSON.parse(intent.plan_json);
    if (raw.planVersion !== 2) return { ...flags, preparation: null, intent: null, legacyPublication: { id: intent.id, state: intent.state } };
    const plan = await checkedStored(intent);
    const copied = await copyProgress(env, intent, plan), canCopy = enabled && row.status === 'draft' && intent.state === 'pending' && copied.length < plan.objects.length;
    const commit = await env.GIZMAGICK_DB.prepare('SELECT published_at FROM admin_publication_commits WHERE publication_id = ?').bind(intent.id).first();
    return { ...flags, preparation: null, legacyPublication: null, intent: { id: intent.id, draftId: row.id,
      trackId: plan.candidate.track.id, versionId: plan.candidate.versionId, planSha256: intent.plan_sha256,
      state: intent.state, publishedAt: commit?.published_at ?? null, copiedObjects: copied.length, totalObjects: plan.objects.length, nextAction: canCopy ? 'copy-one-object' : null,
      continuationBlocked: !canCopy, storageCheckScope: plan.review.storageCheckScope,
      ...(plan.originalImport ? { originalImport: plan.originalImport } : {}) } };
  }
  const prep = await preparationFor(env, row);
  if (!prep) return { ...flags, preparation: null, intent: null, legacyPublication: null };
  const plan = await checkedStored(prep), progress = await batchesFor(env, prep);
  return { ...flags, intent: null, legacyPublication: null, preparation: { id: prep.id, requestId: prep.request_id, draftId: row.id,
    trackId: plan.candidate.track.id, versionId: plan.candidate.versionId, manifestSha256: plan.review.manifestSha256,
    reportSha256: plan.review.reportSha256, snapshotSha256: plan.review.snapshotSha256, planSha256: prep.plan_sha256,
    totalObjects: plan.objects.length, checkedObjects: progress.end, expiresAt: prep.expires_at,
    recent: Boolean(prep.unexpired && progress.recent), storageCheckScope: plan.review.storageCheckScope,
    ...(plan.originalImport ? { originalImport: plan.originalImport } : {}) } };
}
async function inputFor(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'INTENT_JSON', 'Send application/json.');
  const bytes = await readBoundedBody(request, INTENT_LIMITS.inputBytes); let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'INTENT_INPUT', 'Invalid UTF-8 JSON.'); }
  const keys = { prepare: ['action', 'requestId', 'expectedSnapshotSha256', 'expectedReportSha256', 'restartPreparationId'],
    'check-batch': ['action', 'preparationId', 'offset'], reserve: ['action', 'preparationId', 'publicationConfirmed', 'batchWindowConfirmed'],
    'copy-one': ['action', 'publicationId', 'ordinal', 'expectedPlanSha256', 'publicationConfirmed'] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(keys, input.action)
      || Object.keys(input).some(key => !keys[input.action].includes(key))
      || (input.action === 'prepare' && (!uuid(input.requestId) || !sha(input.expectedSnapshotSha256) || !sha(input.expectedReportSha256)
        || (input.restartPreparationId !== undefined && !uuid(input.restartPreparationId))))
      || (['check-batch', 'reserve'].includes(input.action) && !uuid(input.preparationId))
      || (input.action === 'copy-one' && (!uuid(input.publicationId) || !sha(input.expectedPlanSha256) || !Number.isInteger(input.ordinal)
        || input.ordinal < 0 || input.ordinal > 256 || input.publicationConfirmed !== true))
      || (input.action === 'check-batch' && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 256 || input.offset % 16))
      || (input.action === 'reserve' && (input.publicationConfirmed !== true || input.batchWindowConfirmed !== true))) fail(400, 'INTENT_INPUT', 'Supply only the exact preparation identity/action and required separate intent confirmations.');
  return input;
}
async function stillCurrent(env, principal, row, prep, expectedHash) {
  const latest = await preparationFor(env, row), current = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!current || !latest?.unexpired || latest.id !== prep.id || latest.plan_sha256 !== expectedHash) fail(409, 'INTENT_CHANGED', 'Draft or preparation changed/expired. Refresh before continuing.');
  const checked = await reviewedIntentPlan(env, principal, current);
  if (checked.planHash !== expectedHash || checked.allocation.sha256 !== latest.allocation_sha256) fail(409, 'INTENT_CHANGED', 'The reviewed plan or media base changed after preparation.');
  return checked;
}

async function copyIntent(env, principal, row, intent, input, reply) {
  if (!boundedCopyEnabled(env)) fail(503, 'INTENT_COPY_DISABLED', 'Bounded public copying is disabled. Existing public bytes are not removed.');
  await copySchema(env); // Fail before storage writes if the receipt fence is not installed.
  if (!intent || intent.id !== input.publicationId) fail(404, 'INTENT_NOT_FOUND', 'The exact publication intent was not found.');
  const plan = await checkedStored(intent);
  if (intent.plan_sha256 !== input.expectedPlanSha256 || input.ordinal >= plan.objects.length || intent.state !== 'pending') fail(409, 'INTENT_COPY_PLAN', 'Use the exact pending intent, plan checksum and object number.');
  const current = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!current) fail(404, 'INTENT_NOT_FOUND', 'Draft not found.');
  const checked = await reviewedIntentPlan(env, principal, current);
  if (checked.planHash !== intent.plan_sha256) fail(409, 'INTENT_CHANGED', 'The current review, allocations or media base no longer match this fixed plan.');
  const progress = await copyProgress(env, intent, plan);
  // Exact ordinal retries only acknowledge a recorded action. They do not
  // advance to the next object or claim fresh storage verification.
  if (input.ordinal < progress.length) return reply(await statusFor(env, current));
  if (input.ordinal !== progress.length) fail(409, 'INTENT_COPY_ORDER', 'Only the next unrecorded object may be copied. Refresh status.');
  const token = crypto.randomUUID(), db = env.GIZMAGICK_DB;
  const locked = await db.prepare(`UPDATE admin_publications SET lease_token = ?, lease_expires_at = unixepoch('now') + ?
    WHERE id = ? AND owner_id = ? AND state = 'pending' AND lease_expires_at <= unixepoch('now')`).bind(token, PUBLICATION_LIMITS.leaseSeconds, intent.id, principal.id).run();
  if (!changed(locked)) fail(409, 'INTENT_COPY_BUSY', 'Another copy is running. Refresh status; interrupted leases expire after two minutes.');
  try {
    const checkLease = async () => {
      const valid = await db.prepare(`SELECT id FROM admin_publications WHERE id = ? AND state = 'pending'
        AND lease_token = ? AND lease_expires_at > unixepoch('now') AND ${guard(checked)}`)
        .bind(intent.id, token, ...guardArgs(current, checked)).first();
      if (!valid) fail(409, 'INTENT_COPY_CHANGED', 'The lease, draft, review, allocations or new-track identity changed. Bytes may already be public; refresh status.');
    };
    await checkLease();
    const afterLock = await copyProgress(env, intent, plan);
    if (input.ordinal < afterLock.length) return reply(await statusFor(env, current));
    if (input.ordinal !== afterLock.length) fail(409, 'INTENT_COPY_ORDER', 'Copy progress changed. Refresh status.');
    const object = plan.objects[input.ordinal];
    if (object.kind === 'audio') {
      const source = plan.sources.find(asset => asset.assetId === object.assetId);
      const [actual] = await inspectAllocationAssets(env, [checked.allocation.assets.find(asset => asset.assetId === object.assetId)]);
      if (actual.etag !== source.etag) fail(409, 'INTENT_COPY_SOURCE', 'This private file changed since its administrator review.');
    }
    await copyOne(env, current, intent, plan, token, input.ordinal, checkLease);
    return reply(await statusFor(env, current));
  } catch (error) {
    if (String(error.message).includes('Bounded copy changed before receipt')) fail(409, 'INTENT_COPY_CHANGED', 'Copy receipt was rejected because the draft, review, lease or allocations changed. Bytes may already be public. Refresh status.');
    throw error;
  } finally {
    await db.prepare("UPDATE admin_publications SET lease_token = NULL, lease_expires_at = 0 WHERE id = ? AND state = 'pending' AND lease_token = ?").bind(intent.id, token).run();
  }
}

export async function handleIntentRequest(request, env, principal, row, reply, headers) {
  if (!publicationIntentsEnabled(env)) return reply({ error: 'Bounded intent preparation is not enabled.', code: 'INTENT_DISABLED' }, 503);
  if (principal.role !== 'admin') fail(403, 'INTENT_ADMIN', 'Only a verified administrator can prepare their own publication intent.');
  if (new URL(request.url).search) fail(400, 'INTENT_INPUT', 'Intent operations do not accept query parameters.');
  if (['GET', 'HEAD'].includes(request.method)) return reply(await statusFor(env, row));
  if (request.method !== 'POST') { headers.set('Allow', 'GET, HEAD, POST'); return reply({ error: 'Method not allowed', code: 'INTENT_METHOD' }, 405); }
  const input = await inputFor(request), intent = await existingIntent(env, row);
  if (input.action === 'copy-one') return copyIntent(env, principal, row, intent, input, reply);
  if (intent) {
    const plan = JSON.parse(intent.plan_json);
    if (plan.planVersion === 2 && ((input.action === 'reserve' && input.preparationId === intent.id)
      || (input.action === 'prepare' && input.requestId === intent.request_id && input.expectedSnapshotSha256 === plan.review.snapshotSha256
        && input.expectedReportSha256 === plan.review.reportSha256 && !input.restartPreparationId))) return reply(await statusFor(env, row));
    fail(409, 'INTENT_RESERVED', 'An immutable publication already reserves this draft. Its preparation cannot be checked or replaced; use only its exact bounded copy action when enabled.');
  }
  let prep = await preparationFor(env, row);
  if (input.action === 'prepare') {
    const checked = await reviewedIntentPlan(env, principal, row);
    if (checked.plan.review.snapshotSha256 !== input.expectedSnapshotSha256 || checked.plan.review.reportSha256 !== input.expectedReportSha256) fail(409, 'INTENT_REVIEW', 'Use the exact current administrator review checksums.');
    if (input.restartPreparationId && prep?.id !== input.restartPreparationId) fail(409, 'INTENT_CHANGED', 'Refresh the current preparation ID before restarting.');
    if (prep?.unexpired && prep.request_id !== input.requestId && !input.restartPreparationId) fail(409, 'INTENT_REQUEST', 'Another preparation exists. Refresh its status and reuse its request ID.');
    const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_publication_intent_preparations
      (draft_id, id, owner_id, request_id, plan_json, plan_sha256, allocation_sha256, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, unixepoch('now') + 900 WHERE ${guard(checked)}
      AND NOT EXISTS (SELECT 1 FROM admin_publications WHERE draft_id = ?)
      ON CONFLICT(draft_id) DO UPDATE SET id = excluded.id, owner_id = excluded.owner_id, request_id = excluded.request_id,
        plan_json = excluded.plan_json, plan_sha256 = excluded.plan_sha256, allocation_sha256 = excluded.allocation_sha256,
        expires_at = excluded.expires_at, created_at = unixepoch('now')
      WHERE admin_publication_intent_preparations.expires_at <= unixepoch('now') OR admin_publication_intent_preparations.plan_sha256 != excluded.plan_sha256
        OR admin_publication_intent_preparations.id = ? OR EXISTS (SELECT 1 FROM admin_publication_intent_batches
          WHERE preparation_id = admin_publication_intent_preparations.id AND (checked_at < unixepoch('now') - 300 OR checked_at > unixepoch('now')))`)
      .bind(row.id, crypto.randomUUID(), principal.id, input.requestId, JSON.stringify(checked.plan), checked.planHash, checked.allocation.sha256,
        ...guardArgs(row, checked), row.id, input.restartPreparationId || '').run();
    prep = await preparationFor(env, row);
    if (!prep || prep.request_id !== input.requestId || (input.restartPreparationId && !changed(saved))) fail(409, 'INTENT_CHANGED', 'Draft or preparation changed while starting.');
    await stillCurrent(env, principal, row, prep, checked.planHash);
    return reply(await statusFor(env, row), changed(saved) ? 201 : 200);
  }
  if (!prep?.unexpired || prep.id !== input.preparationId) fail(409, 'INTENT_PREPARATION', 'Refresh or explicitly restart the current preparation.');
  const plan = await checkedStored(prep), checked = await stillCurrent(env, principal, row, prep, prep.plan_sha256), progress = await batchesFor(env, prep);
  if (!progress.recent) fail(409, 'INTENT_OLD_CHECKS', 'Checks are over five minutes old. Start a fresh preparation pass.');
  if (input.action === 'check-batch') {
    if (progress.results.some(batch => batch.offset === input.offset)) return reply(await statusFor(env, row));
    if (input.offset !== progress.end || input.offset >= plan.objects.length) fail(409, 'INTENT_OFFSET', 'Only the next unchecked batch can run.');
    const end = Math.min(input.offset + 16, plan.objects.length), selected = plan.objects.slice(input.offset, end);
    const sources = selected.filter(object => object.kind === 'audio').map(object => checked.allocation.assets.find(asset => asset.assetId === object.assetId));
    const privateObjects = await inspectAllocationAssets(env, sources);
    if (privateObjects.some(asset => asset.etag !== plan.sources.find(source => source.assetId === asset.assetId).etag)) fail(409, 'INTENT_SOURCE', 'A private file changed since its administrator review.');
    for (const object of selected) if (await env.GIZMAGICK_MEDIA.head(object.key)) fail(409, 'INTENT_DESTINATION', 'A proposed public object already exists. Nothing is overwritten or adopted.');
    await stillCurrent(env, principal, row, prep, prep.plan_sha256);
    await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_publication_intent_batches (preparation_id, offset, end_offset)
      SELECT ?, ?, ? WHERE ${guard(checked)}
      AND EXISTS (SELECT 1 FROM admin_publication_intent_preparations WHERE draft_id = ? AND id = ? AND plan_sha256 = ? AND expires_at > unixepoch('now'))
      AND NOT EXISTS (SELECT 1 FROM admin_publications WHERE draft_id = ?)
      AND COALESCE((SELECT MAX(end_offset) FROM admin_publication_intent_batches WHERE preparation_id = ?), 0) = ?
      ON CONFLICT(preparation_id, offset) DO NOTHING`).bind(prep.id, input.offset, end, ...guardArgs(row, checked), row.id, prep.id, prep.plan_sha256, row.id, prep.id, input.offset).run();
    await stillCurrent(env, principal, row, prep, prep.plan_sha256);
    if (!(await batchesFor(env, prep)).results.some(batch => batch.offset === input.offset)) fail(409, 'INTENT_CHANGED', 'The batch could not be recorded under this exact preparation.');
    return reply(await statusFor(env, row));
  }
  if (progress.end !== plan.objects.length) fail(409, 'INTENT_INCOMPLETE', 'Check every private source and public destination before reserving the intent.');
  const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_publications (id, draft_id, owner_id, request_id, track_id, version_id, plan_json, plan_sha256)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard(checked)}
    AND EXISTS (SELECT 1 FROM admin_publication_intent_preparations WHERE draft_id = ? AND id = ? AND plan_sha256 = ? AND expires_at > unixepoch('now'))
    AND (SELECT MIN(checked_at) FROM admin_publication_intent_batches WHERE preparation_id = ?) >= unixepoch('now') - 300
    AND (SELECT MAX(checked_at) FROM admin_publication_intent_batches WHERE preparation_id = ?) <= unixepoch('now')
    ON CONFLICT DO NOTHING`).bind(prep.id, row.id, principal.id, prep.request_id, plan.candidate.track.id, plan.candidate.versionId,
      prep.plan_json, prep.plan_sha256, ...guardArgs(row, checked), row.id, prep.id, prep.plan_sha256, prep.id, prep.id).run();
  const reserved = await existingIntent(env, row);
  if (!reserved || reserved.id !== prep.id || reserved.plan_sha256 !== prep.plan_sha256) fail(409, 'INTENT_CHANGED', 'Draft, review, identity or preparation changed before the intent could be reserved.');
  return reply(await statusFor(env, row), changed(saved) ? 201 : 200);
}
