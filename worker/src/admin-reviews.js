import checkStructure from './generated/manifest-validator.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { UUID_PATTERN } from '../../shared/library-contract.js';
import { REVIEW_POLICY, REVIEW_REPORT_BYTES, REVIEW_PACKAGE_BYTES, jsonSha256, checkReviewReport } from '../../shared/draft-review.js';
import { DraftError, readBoundedBody } from './admin-drafts.js';

export const reviewsEnabled = env => env.GIZMAGICK_DRAFT_REVIEWS_ENABLED === 'true';
const fail = (status, code, message, details) => { throw new DraftError(status, code, message, details); };
const validate = manifest => validateManifestWithStructure(manifest, checkStructure);
const packageFor = job => ({ packageVersion: 1, policy: REVIEW_POLICY, jobId: job.id,
  expiresAt: job.expires_at, snapshotSha256: job.snapshot_sha256, snapshot: JSON.parse(job.snapshot_json) });
const reviewSummary = row => row ? { scope: row.scope, approvedBy: row.approved_by, approvedAt: row.approved_at,
  reportSha256: row.report_sha256, snapshotSha256: row.snapshot_sha256, publishing: false, serverDecoded: false } : null;

export async function getDraftReview(env, id) {
  if (!reviewsEnabled(env)) return null;
  return reviewSummary(await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').bind(id).first());
}

async function snapshotDraft(env, row) {
  if (row.status !== 'draft') fail(409, 'REVIEW_ARCHIVED', 'Archived drafts cannot be reviewed.');
  const manifest = JSON.parse(row.manifest_json);
  if (!validate(manifest).valid) fail(409, 'REVIEW_METADATA', 'Draft metadata no longer passes validation.');
  const { results } = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_assets WHERE draft_id = ? ORDER BY asset_id').bind(row.id).all();
  if (results.length !== Object.keys(manifest.assets).length || results.some(asset => asset.state !== 'uploaded' || !Object.hasOwn(manifest.assets, asset.asset_id))) {
    fail(409, 'REVIEW_INCOMPLETE', 'Upload every referenced audio file before requesting a review package.');
  }
  const assets = [];
  // Sequential HEAD checks bound concurrent work; no decoding or public reads.
  for (const asset of results) {
    const object = await env.GIZMAGICK_DRAFTS.head(asset.object_key);
    const checksum = object?.checksums?.sha256;
    const storedHash = checksum ? Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, '0')).join('') : null;
    if (!object || !object.etag || object.size !== asset.byte_length || object.customMetadata?.sha256 !== asset.sha256 || storedHash !== asset.sha256) {
      fail(409, 'REVIEW_STORAGE', 'An uploaded private object is missing or changed.');
    }
    assets.push({ assetId: asset.asset_id, path: manifest.assets[asset.asset_id].path, objectKey: asset.object_key,
      byteLength: asset.byte_length, sha256: asset.sha256, etag: object.etag });
  }
  return { draftId: row.id, manifest, assets };
}

export async function handleReviewRequest(request, env, principal, row, operation, reply) {
  if (!reviewsEnabled(env)) return reply({ error: 'Administrator reviews are not enabled.', code: 'REVIEW_NOT_CONFIGURED' }, 503);
  if (principal.role !== 'admin') fail(403, 'REVIEW_ADMIN_ONLY', 'Only a verified administrator can attest a local review.');
  if (request.method !== 'POST') return reply({ error: 'Method not allowed', code: 'REVIEW_METHOD' }, 405);
  if (operation === 'review-package') {
    if (await getDraftReview(env, row.id)) fail(409, 'REVIEW_ALREADY_ATTESTED', 'This immutable draft already has an administrator attestation.');
    const snapshot = await snapshotDraft(env, row), snapshotHash = await jsonSha256(snapshot);
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > REVIEW_PACKAGE_BYTES - 2048) fail(413, 'REVIEW_SIZE', 'Review package exceeds its metadata limit.');
    await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_review_jobs (draft_id, id, snapshot_json, snapshot_sha256, expires_at)
      SELECT ?, ?, ?, ?, unixepoch('now') + 86400 WHERE EXISTS (SELECT 1 FROM admin_drafts WHERE id = ? AND owner_id = ? AND status = 'draft' AND manifest_json = ?)
      AND NOT EXISTS (SELECT 1 FROM admin_draft_reviews WHERE draft_id = ?)
      ON CONFLICT(draft_id) DO UPDATE SET id = excluded.id, snapshot_json = excluded.snapshot_json,
        snapshot_sha256 = excluded.snapshot_sha256, expires_at = excluded.expires_at, created_at = excluded.created_at
      WHERE (admin_draft_review_jobs.expires_at <= unixepoch('now') OR admin_draft_review_jobs.snapshot_sha256 != excluded.snapshot_sha256)
        AND NOT EXISTS (SELECT 1 FROM admin_draft_reviews WHERE draft_id = excluded.draft_id)`)
      .bind(row.id, crypto.randomUUID(), JSON.stringify(snapshot), snapshotHash, row.id, principal.id, row.manifest_json, row.id).run();
    const job = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_review_jobs WHERE draft_id = ?').bind(row.id).first();
    if (!job || job.snapshot_sha256 !== snapshotHash) fail(409, 'REVIEW_CHANGED', 'Draft changed while preparing the review. Reopen it and try again.');
    return reply(packageFor(job));
  }
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'REVIEW_JSON', 'Send application/json.');
  const bytes = await readBoundedBody(request, REVIEW_REPORT_BYTES + 2048);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'REVIEW_JSON', 'Invalid UTF-8 JSON.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['report', 'policy', 'provenanceConfirmed'].includes(key))
      || input.policy !== REVIEW_POLICY || input.provenanceConfirmed !== true || !UUID_PATTERN.test(input.report?.jobId || '')) {
    fail(400, 'REVIEW_CONFIRMATION', 'Explicitly confirm that you ran this package through the local validator and reviewed its results.');
  }
  const job = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ?').bind(row.id, input.report.jobId).first();
  if (!job) fail(409, 'REVIEW_JOB', 'This report does not belong to the current review package.');
  const snapshot = await snapshotDraft(env, row);
  if (await jsonSha256(snapshot) !== job.snapshot_sha256) fail(409, 'REVIEW_STALE', 'Metadata or private audio changed after this review package was prepared.');
  const checked = await checkReviewReport(packageFor(job), input.report, validate);
  if (!checked.valid) fail(422, 'REVIEW_REPORT', 'The report does not pass the review contract.', checked.errors.slice(0, 30));
  const reportHash = await jsonSha256(input.report);
  const existing = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first();
  if (existing) {
    if (existing.report_sha256 !== reportHash || existing.job_id !== job.id) fail(409, 'REVIEW_CONFLICT', 'This draft was already attested with a different report.');
    return reply({ review: reviewSummary(existing), audioProbed: false, publishing: false });
  }
  // One conditional INSERT is the approval/audit record. It rechecks archival,
  // expiry, metadata, job identity and every D1 asset in the write itself.
  const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_reviews
    (draft_id, job_id, approved_by, policy, scope, snapshot_sha256, manifest_sha256, report_sha256, report_json, candidate_json)
    SELECT ?, ?, ?, ?, 'administrator-attested', ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM admin_drafts WHERE id = ? AND owner_id = ? AND status = 'draft' AND manifest_json = ?)
    AND EXISTS (SELECT 1 FROM admin_draft_review_jobs WHERE draft_id = ? AND id = ? AND snapshot_sha256 = ? AND expires_at > unixepoch('now'))
    AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = ?) = ?
    AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM admin_draft_assets a
      WHERE a.draft_id = ? AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
        AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256') AND a.state = 'uploaded'))
    ON CONFLICT(draft_id) DO NOTHING`).bind(row.id, job.id, principal.id, REVIEW_POLICY, job.snapshot_sha256,
      input.report.manifestSha256, reportHash, JSON.stringify(input.report), JSON.stringify(checked.candidate),
      row.id, principal.id, row.manifest_json, row.id, job.id, job.snapshot_sha256, row.id, snapshot.assets.length,
      JSON.stringify(snapshot.assets), row.id).run();
  const review = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first();
  if (!review || review.report_sha256 !== reportHash) fail(409, 'REVIEW_CHANGED', 'Review expired, changed, or conflicted during confirmation. Reopen the draft.');
  return reply({ review: reviewSummary(review), audioProbed: false, publishing: false }, Number(saved.meta?.changes ?? saved.changes ?? 0) ? 201 : 200);
}
