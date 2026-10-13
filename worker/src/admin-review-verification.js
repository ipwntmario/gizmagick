import checkStructure from './generated/manifest-validator.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { REVIEW_POLICY, REVIEW_PACKAGE_BYTES, REVIEW_REPORT_BYTES, jsonSha256, checkReviewReport } from '../../shared/draft-review.js';
import { UUID_PATTERN } from '../../shared/library-contract.js';
import { DraftError, readBoundedBody, draftsEnabled } from './admin-drafts.js';
import { reviewsEnabled, packageFor, reviewSummary } from './admin-reviews.js';
import { allocationSnapshot, inspectAllocationAssets } from './admin-storage-inspection.js';
import { currentGuard, guardArgs } from './admin-review-packages.js';

export const batchReviewEnabled = env => draftsEnabled(env) && reviewsEnabled(env)
  && env.GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED === 'true';
export const VERIFICATION_LIMITS = Object.freeze({ batch: 16, lifetime: 900, freshness: 300 });
const fail = (status, code, message, details) => { throw new DraftError(status, code, message, details); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);
const validate = manifest => validateManifestWithStructure(manifest, checkStructure);
const getReview = (env, row) => env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first();
const getAttempt = (env, row) => env.GIZMAGICK_DB.prepare("SELECT *, expires_at > unixepoch('now') AS unexpired FROM admin_draft_review_verifications WHERE draft_id = ?").bind(row.id).first();

async function inputFor(request, operation) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'VERIFICATION_JSON', 'Send application/json.');
  const starting = operation === 'review-verification', final = operation === 'attest-review-batched';
  const bytes = await readBoundedBody(request, starting ? REVIEW_REPORT_BYTES + 2048 : 2048);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'VERIFICATION_INPUT', 'Invalid UTF-8 JSON.'); }
  const keys = starting ? ['report', 'policy', 'provenanceConfirmed', 'restartVerificationId'] : final
    ? ['verificationId', 'policy', 'provenanceConfirmed', 'batchWindowConfirmed'] : ['verificationId', 'offset'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
      || (starting && (!UUID_PATTERN.test(input.report?.jobId || '')
        || (input.restartVerificationId !== undefined && !UUID_PATTERN.test(input.restartVerificationId))))
      || (!starting && !UUID_PATTERN.test(input.verificationId || ''))
      || ((starting || final) && (input.policy !== REVIEW_POLICY || input.provenanceConfirmed !== true))
      || (final && input.batchWindowConfirmed !== true)
      || (!starting && !final && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 240 || input.offset % 16))) {
    fail(400, 'VERIFICATION_CONFIRMATION', 'Supply the exact verification identity and required personal-run/batch-window confirmations.');
  }
  return input;
}

async function checkedContext(env, principal, row, jobId, report, attempt) {
  if (row.status !== 'draft' || row.owner_id !== principal.id) fail(409, 'VERIFICATION_CHANGED', 'Open an active draft owned by this administrator.');
  const job = await env.GIZMAGICK_DB.prepare("SELECT *, expires_at > unixepoch('now') AS unexpired FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ?").bind(row.id, jobId).first();
  if (!job?.unexpired) fail(409, 'VERIFICATION_JOB', 'The review package changed or expired. Prepare a fresh package and rerun local validation.');
  if (new TextEncoder().encode(job.snapshot_json).length > REVIEW_PACKAGE_BYTES
      || new TextEncoder().encode(JSON.stringify(report)).length > REVIEW_REPORT_BYTES) fail(413, 'VERIFICATION_SIZE', 'Review data exceeds its limits.');
  const snapshot = await allocationSnapshot(env, row), packaged = JSON.parse(job.snapshot_json);
  if (!packaged || typeof packaged !== 'object' || await jsonSha256(packaged) !== job.snapshot_sha256 || packaged.draftId !== row.id
      || await jsonSha256(packaged.manifest) !== await jsonSha256(snapshot.manifest)
      || !Array.isArray(packaged.assets) || packaged.assets.length !== snapshot.assets.length
      || packaged.assets.some((asset, index) => {
        const allocated = snapshot.assets[index];
        return asset.assetId !== allocated.assetId || asset.path !== allocated.path || asset.objectKey !== allocated.objectKey
          || asset.byteLength !== allocated.byteLength || asset.sha256 !== allocated.sha256 || typeof asset.etag !== 'string' || !asset.etag;
      })) fail(409, 'VERIFICATION_STALE', 'Package metadata or allocations no longer match this draft.');
  const reportHash = await jsonSha256(report);
  if (attempt && (!attempt.unexpired || attempt.owner_id !== principal.id || attempt.job_id !== job.id
      || attempt.snapshot_sha256 !== job.snapshot_sha256 || attempt.allocation_sha256 !== snapshot.sha256 || attempt.report_sha256 !== reportHash)) {
    fail(409, 'VERIFICATION_STALE', 'Verification expired or its exact package/report/allocations changed. Restart the checks.');
  }
  const checked = await checkReviewReport(packageFor(job), report, validate);
  if (!checked.valid) fail(422, 'VERIFICATION_REPORT', 'The report does not pass the review contract.', checked.errors.slice(0, 30));
  return { job, snapshot, packaged, report, reportHash, candidate: checked.candidate };
}

async function progressFor(env, attempt) {
  const { results } = await env.GIZMAGICK_DB.prepare(`SELECT *, checked_at >= unixepoch('now') - 300 AND checked_at <= unixepoch('now') AS recent
    FROM admin_draft_review_verification_batches WHERE verification_id = ? ORDER BY offset LIMIT 17`).bind(attempt.id).all();
  let end = 0;
  for (const batch of results) {
    if (batch.offset !== end) fail(409, 'VERIFICATION_PROGRESS', 'Verification batch history is inconsistent. Restart the checks.');
    end = batch.end_offset;
  }
  return { batches: results, end, recent: results.every(batch => batch.recent),
    first: results.length ? Math.min(...results.map(batch => batch.checked_at)) : null,
    last: results.length ? Math.max(...results.map(batch => batch.checked_at)) : null };
}
async function resultFor(env, row, attempt, context, review = null) {
  const progress = await progressFor(env, attempt);
  if (!review && !progress.recent) fail(409, 'VERIFICATION_OLD_CHECKS', 'Earlier checks are over five minutes old. Start a fresh verification pass.');
  return { verification: { id: attempt.id, draftId: row.id, trackId: context.snapshot.manifest.track.id,
    versionId: context.snapshot.manifest.versionId, manifestSha256: await jsonSha256(context.snapshot.manifest), jobId: attempt.job_id,
    reportSha256: attempt.report_sha256, snapshotSha256: attempt.snapshot_sha256, totalAssets: context.snapshot.assets.length,
    checkedAssets: progress.end, expiresAt: attempt.expires_at, firstCheckedAt: progress.first, lastCheckedAt: progress.last,
    state: review ? 'attested' : 'pending' }, review: reviewSummary(review),
    audioProbed: false, serverDecoded: false, publishing: false, publicationAuthorized: false, pointInTimeBatches: true };
}

export async function handleBatchReviewRequest(request, env, principal, row, operation, reply, headers) {
  if (!batchReviewEnabled(env)) return reply({ error: 'Batched administrator rechecks are not enabled.', code: 'VERIFICATION_DISABLED' }, 503);
  if (principal.role !== 'admin') fail(403, 'VERIFICATION_ADMIN', 'Only a verified administrator can recheck and attest a local report.');
  const read = operation === 'review-verification' && ['GET', 'HEAD'].includes(request.method);
  if (!read && request.method !== 'POST') {
    headers.set('Allow', operation === 'review-verification' ? 'GET, HEAD, POST' : 'POST');
    return reply({ error: 'Method not allowed', code: 'VERIFICATION_METHOD' }, 405);
  }
  if (new URL(request.url).search) fail(400, 'VERIFICATION_INPUT', 'Verification operations do not accept query parameters.');
  const attempt = await getAttempt(env, row), review = await getReview(env, row);
  const input = read ? null : await inputFor(request, operation);
  if (review) {
    if (!attempt || review.storage_verification_id !== attempt.id || review.approved_by !== principal.id
        || review.report_sha256 !== attempt.report_sha256 || review.job_id !== attempt.job_id) fail(409, 'VERIFICATION_ALREADY_REVIEWED', 'This draft already has a different immutable attestation.');
    if (!read && (operation !== 'attest-review-batched' || input.verificationId !== attempt.id)) fail(409, 'VERIFICATION_ALREADY_REVIEWED', 'This exact verification was already attested; no further checks or restarts are allowed.');
    const manifest = JSON.parse(row.manifest_json);
    return reply(await resultFor(env, row, attempt, { snapshot: { manifest, assets: Object.values(manifest.assets) } }, review));
  }
  if (read && !attempt) return reply({ verification: null, review: null, audioProbed: false, serverDecoded: false,
    publishing: false, publicationAuthorized: false, pointInTimeBatches: true });
  if (operation === 'review-verification' && !read) {
    const context = await checkedContext(env, principal, row, input.report.jobId, input.report);
    if (input.restartVerificationId && attempt?.id !== input.restartVerificationId) fail(409, 'VERIFICATION_CHANGED', 'Refresh the current verification identity before restarting.');
    const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_review_verifications
      (draft_id, id, owner_id, job_id, snapshot_sha256, allocation_sha256, report_json, report_sha256, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, MIN(?, unixepoch('now') + 900) WHERE ${currentGuard}
      AND EXISTS (SELECT 1 FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ? AND snapshot_sha256 = ? AND expires_at > unixepoch('now'))
      ON CONFLICT(draft_id) DO UPDATE SET id = excluded.id, owner_id = excluded.owner_id, job_id = excluded.job_id,
        snapshot_sha256 = excluded.snapshot_sha256, allocation_sha256 = excluded.allocation_sha256, report_json = excluded.report_json,
        report_sha256 = excluded.report_sha256, expires_at = excluded.expires_at, created_at = unixepoch('now')
      WHERE admin_draft_review_verifications.expires_at <= unixepoch('now') OR admin_draft_review_verifications.report_sha256 != excluded.report_sha256
        OR admin_draft_review_verifications.allocation_sha256 != excluded.allocation_sha256
        OR admin_draft_review_verifications.snapshot_sha256 != excluded.snapshot_sha256 OR admin_draft_review_verifications.owner_id != excluded.owner_id
        OR admin_draft_review_verifications.id = ? OR EXISTS (SELECT 1 FROM admin_draft_review_verification_batches
          WHERE verification_id = admin_draft_review_verifications.id AND (checked_at < unixepoch('now') - 300 OR checked_at > unixepoch('now')))`)
      .bind(row.id, crypto.randomUUID(), principal.id, context.job.id, context.job.snapshot_sha256, context.snapshot.sha256,
        JSON.stringify(context.report), context.reportHash, context.job.expires_at, ...guardArgs(row, principal, context.snapshot),
        row.id, context.job.id, context.job.snapshot_sha256, input.restartVerificationId || '').run();
    const latest = await getAttempt(env, row);
    if (!latest || latest.report_sha256 !== context.reportHash || latest.job_id !== context.job.id
        || (input.restartVerificationId && (!changed(saved) || latest.id === input.restartVerificationId))) fail(409, 'VERIFICATION_CHANGED', 'Draft changed while starting checks. Refresh and try again.');
    return reply(await validatedResult(env, row, principal, latest));
  }
  if (!attempt || (!read && attempt.id !== input.verificationId)) fail(409, 'VERIFICATION_ID', 'Refresh and use the current verification identity.');
  const context = await checkedContext(env, principal, row, attempt.job_id, JSON.parse(attempt.report_json), attempt);
  const progress = await progressFor(env, attempt);
  if (!progress.recent) fail(409, 'VERIFICATION_OLD_CHECKS', 'Earlier checks are over five minutes old. Start a fresh verification pass.');
  if (read) return reply(await resultFor(env, row, attempt, context));
  if (operation === 'review-verification-batch') {
    if (progress.batches.some(batch => batch.offset === input.offset)) return reply(await validatedResult(env, row, principal, attempt));
    if (input.offset !== progress.end || input.offset >= context.snapshot.assets.length) fail(409, 'VERIFICATION_OFFSET', 'Only the next unchecked batch can run. Refresh progress.');
    const end = Math.min(input.offset + 16, context.snapshot.assets.length);
    const checked = await inspectAllocationAssets(env, context.snapshot.assets.slice(input.offset, end));
    if (checked.some((asset, index) => asset.etag !== context.packaged.assets[input.offset + index].etag)) fail(409, 'VERIFICATION_OBJECT', 'A private file changed after the local review package was prepared.');
    const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_review_verification_batches (verification_id, offset, end_offset)
      SELECT ?, ?, ? WHERE ${currentGuard} AND EXISTS (SELECT 1 FROM admin_draft_review_verifications
        WHERE draft_id = ? AND id = ? AND report_sha256 = ? AND expires_at > unixepoch('now'))
      AND EXISTS (SELECT 1 FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ? AND snapshot_sha256 = ? AND expires_at > unixepoch('now'))
      AND COALESCE((SELECT MAX(end_offset) FROM admin_draft_review_verification_batches WHERE verification_id = ?), 0) = ?
      ON CONFLICT(verification_id, offset) DO NOTHING`).bind(attempt.id, input.offset, end, ...guardArgs(row, principal, context.snapshot),
      row.id, attempt.id, context.reportHash, row.id, context.job.id, context.job.snapshot_sha256, attempt.id, input.offset).run();
    if (!changed(saved) && !(await progressFor(env, attempt)).batches.some(batch => batch.offset === input.offset)) fail(409, 'VERIFICATION_CHANGED', 'Draft or verification changed during this batch. Refresh and restart.');
    return reply(await validatedResult(env, row, principal, attempt));
  }
  if (progress.end !== context.snapshot.assets.length) fail(409, 'VERIFICATION_INCOMPLETE', 'Recheck all files before the separate final attestation.');
  const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_reviews
    (draft_id, job_id, approved_by, policy, scope, snapshot_sha256, manifest_sha256, report_sha256, report_json, candidate_json,
      storage_check_scope, storage_verification_id, storage_checked_from, storage_checked_until)
    SELECT ?, ?, ?, ?, 'administrator-attested', ?, ?, ?, ?, ?, 'bounded-batches', ?, ?, ? WHERE ${currentGuard}
    AND EXISTS (SELECT 1 FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ? AND snapshot_sha256 = ? AND expires_at > unixepoch('now'))
    AND EXISTS (SELECT 1 FROM admin_draft_review_verifications WHERE draft_id = ? AND id = ? AND owner_id = ? AND report_sha256 = ? AND expires_at > unixepoch('now'))
    AND (SELECT MIN(checked_at) FROM admin_draft_review_verification_batches WHERE verification_id = ?) >= unixepoch('now') - 300
    AND (SELECT MAX(checked_at) FROM admin_draft_review_verification_batches WHERE verification_id = ?) <= unixepoch('now')
    ON CONFLICT(draft_id) DO NOTHING`).bind(row.id, context.job.id, principal.id, REVIEW_POLICY, context.job.snapshot_sha256,
      await jsonSha256(context.snapshot.manifest), context.reportHash, JSON.stringify(context.report), JSON.stringify(context.candidate),
      attempt.id, progress.first, progress.last, ...guardArgs(row, principal, context.snapshot), row.id, context.job.id, context.job.snapshot_sha256,
      row.id, attempt.id, principal.id, context.reportHash, attempt.id, attempt.id).run();
  const recorded = await getReview(env, row);
  if (!recorded || recorded.storage_verification_id !== attempt.id || recorded.report_sha256 !== context.reportHash) fail(409, 'VERIFICATION_CHANGED', 'Review expired, changed or conflicted before attestation. No matching approval was recorded.');
  return reply(await resultFor(env, row, attempt, context, recorded), changed(saved) ? 201 : 200);
}

async function validatedResult(env, row, principal, expected) {
  const latest = await getAttempt(env, row), current = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!current || latest?.id !== expected.id || await getReview(env, row)) fail(409, 'VERIFICATION_CHANGED', 'Draft or verification changed. Reopen and refresh.');
  const context = await checkedContext(env, principal, current, latest.job_id, JSON.parse(latest.report_json), latest);
  return resultFor(env, current, latest, context);
}
