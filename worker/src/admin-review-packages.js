import { DraftError, readBoundedBody, draftsEnabled } from './admin-drafts.js';
import { reviewsEnabled, packageFor } from './admin-reviews.js';
import { allocationSnapshot, inspectAllocationAssets, STORAGE_INSPECTION_BATCH_SIZE } from './admin-storage-inspection.js';
import { jsonSha256, REVIEW_PACKAGE_BYTES } from '../../shared/draft-review.js';
import { UUID_PATTERN } from '../../shared/library-contract.js';

export const batchPackagesEnabled = env => draftsEnabled(env) && reviewsEnabled(env)
  && env.GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED === 'true';
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);
// The same allocation/ownership/attestation predicates fence every database write.
export const currentGuard = `EXISTS (SELECT 1 FROM admin_drafts WHERE id = ? AND owner_id = ? AND status = 'draft' AND manifest_json = ?)
  AND NOT EXISTS (SELECT 1 FROM admin_draft_reviews WHERE draft_id = ?)
  AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = ?) = ?
  AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM admin_draft_assets a
    WHERE a.draft_id = ? AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
      AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256') AND a.state = 'uploaded'))`;
export const guardArgs = (row, principal, snapshot) => [row.id, principal.id, row.manifest_json, row.id, row.id,
  snapshot.assets.length, JSON.stringify(snapshot.assets), row.id];

async function inputFor(request, operation) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'PACKAGE_JSON', 'Send application/json.');
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 2048))); }
  catch (error) { if (error instanceof DraftError) throw error; fail(400, 'PACKAGE_INPUT', 'Invalid UTF-8 JSON.'); }
  const keys = operation === 'review-package-batches' ? ['restartJobId'] : operation === 'review-package-batch' ? ['jobId', 'offset'] : ['jobId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
      || (operation !== 'review-package-batches' && !UUID_PATTERN.test(input.jobId || ''))
      || (input.restartJobId !== undefined && !UUID_PATTERN.test(input.restartJobId))
      || (operation === 'review-package-batch' && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 240 || input.offset % 16))) {
    fail(400, 'PACKAGE_INPUT', 'Supply only the exact package identity and batch offset requested by this operation.');
  }
  return input;
}

async function getPreparation(env, row) {
  return env.GIZMAGICK_DB.prepare('SELECT *, expires_at > unixepoch(\'now\') AS unexpired FROM admin_draft_package_preparations WHERE draft_id = ?').bind(row.id).first();
}
async function requireCurrent(env, row, job) {
  if (!job?.unexpired) fail(409, 'PACKAGE_EXPIRED', 'Package preparation expired or is missing. Start or restart it.');
  const snapshot = await allocationSnapshot(env, row);
  if (snapshot.sha256 !== job.allocation_sha256) fail(409, 'PACKAGE_STALE', 'Metadata or allocations changed. Reopen the draft and start a fresh package.');
  return snapshot;
}
async function currentSnapshot(env, row, principal, job) {
  const current = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!current || await env.GIZMAGICK_DB.prepare('SELECT draft_id FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first()) {
    fail(409, 'PACKAGE_CHANGED', 'Draft ownership or attestation changed. Reopen the draft.');
  }
  return requireCurrent(env, current, job);
}
async function batchRows(env, job) {
  const { results } = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_package_batches WHERE preparation_id = ? ORDER BY offset LIMIT 17').bind(job.id).all();
  let end = 0;
  for (const batch of results) {
    if (batch.offset !== end) fail(409, 'PACKAGE_PROGRESS', 'Package batch history is inconsistent. Restart preparation.');
    end = batch.end_offset;
  }
  return { results, end };
}
async function resultFor(env, row, job, snapshot) {
  const progress = await batchRows(env, job);
  const reviewJob = await env.GIZMAGICK_DB.prepare('SELECT id FROM admin_draft_review_jobs WHERE draft_id = ?').bind(row.id).first();
  return { preparation: { jobId: job.id, draftId: row.id, trackId: snapshot.manifest.track.id,
    versionId: snapshot.manifest.versionId, manifestSha256: await jsonSha256(snapshot.manifest),
    totalAssets: snapshot.assets.length, checkedAssets: progress.end, expiresAt: job.expires_at,
    ready: reviewJob?.id === job.id }, audioProbed: false, publishing: false, publicationAuthorized: false };
}

export async function handleBatchPackageRequest(request, env, principal, row, operation, reply, headers) {
  // Do not query migration 0005 tables until deliberately enabled.
  if (!batchPackagesEnabled(env)) return reply({ error: 'Batched review packages are not enabled.', code: 'PACKAGE_DISABLED' }, 503);
  if (principal.role !== 'admin') fail(403, 'PACKAGE_ADMIN_ONLY', 'Only a verified administrator can prepare a local review package.');
  const statusRead = operation === 'review-package-batches' && ['GET', 'HEAD'].includes(request.method);
  if (!statusRead && request.method !== 'POST') {
    headers.set('Allow', operation === 'review-package-batches' ? 'GET, HEAD, POST' : 'POST');
    return reply({ error: 'Method not allowed', code: 'PACKAGE_METHOD' }, 405);
  }
  if (new URL(request.url).search) fail(400, 'PACKAGE_INPUT', 'Package operations do not accept query parameters.');
  if (row.status !== 'draft') fail(409, 'PACKAGE_ARCHIVED', 'Archived drafts cannot prepare review packages.');
  if (await env.GIZMAGICK_DB.prepare('SELECT draft_id FROM admin_draft_reviews WHERE draft_id = ?').bind(row.id).first()) {
    fail(409, 'PACKAGE_ATTESTED', 'Attested drafts cannot replace their review package.');
  }
  let job = await getPreparation(env, row);
  if (statusRead) {
    if (!job) return reply({ preparation: null, audioProbed: false, publishing: false, publicationAuthorized: false });
    return reply(await resultFor(env, row, job, await requireCurrent(env, row, job)));
  }
  const input = await inputFor(request, operation);
  if (operation === 'review-package-batches') {
    const snapshot = await allocationSnapshot(env, row);
    if (input.restartJobId && job?.id !== input.restartJobId) fail(409, 'PACKAGE_CHANGED', 'Preparation identity changed. Refresh its status before restarting.');
    const document = JSON.stringify({ draftId: row.id, manifest: snapshot.manifest, assets: snapshot.assets });
    if (new TextEncoder().encode(document).length > REVIEW_PACKAGE_BYTES - 4096) fail(413, 'PACKAGE_SIZE', 'Review package metadata exceeds its limit.');
    const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_package_preparations
      (draft_id, id, allocation_json, allocation_sha256, expires_at) SELECT ?, ?, ?, ?, unixepoch('now') + 86400 WHERE ${currentGuard}
      ON CONFLICT(draft_id) DO UPDATE SET id = excluded.id, allocation_json = excluded.allocation_json,
        allocation_sha256 = excluded.allocation_sha256, expires_at = excluded.expires_at,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE admin_draft_package_preparations.expires_at <= unixepoch('now')
        OR admin_draft_package_preparations.allocation_sha256 != excluded.allocation_sha256
        OR admin_draft_package_preparations.id = ?`).bind(row.id, crypto.randomUUID(), document, snapshot.sha256,
      ...guardArgs(row, principal, snapshot), input.restartJobId || '').run();
    job = await getPreparation(env, row);
    if (!job || job.allocation_sha256 !== snapshot.sha256 || (input.restartJobId && !changed(saved))) fail(409, 'PACKAGE_CHANGED', 'Draft or preparation changed while starting. Refresh and try again.');
    return reply(await resultFor(env, row, job, await currentSnapshot(env, row, principal, job)), changed(saved) ? 201 : 200);
  }
  if (job?.id !== input.jobId) fail(409, 'PACKAGE_CHANGED', 'Use the current preparation identity. Refresh before continuing.');
  const snapshot = await requireCurrent(env, row, job), progress = await batchRows(env, job);
  if (operation === 'review-package-batch') {
    const previous = progress.results.find(batch => batch.offset === input.offset);
    if (previous) return reply(await resultFor(env, row, job, snapshot)); // Lost-response retry, no repeated R2 work.
    if (input.offset !== progress.end || input.offset >= snapshot.assets.length) fail(409, 'PACKAGE_OFFSET', 'Only the next unchecked batch can be prepared. Refresh its progress.');
    const end = Math.min(input.offset + STORAGE_INSPECTION_BATCH_SIZE, snapshot.assets.length);
    const assets = await inspectAllocationAssets(env, snapshot.assets.slice(input.offset, end));
    const saved = await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_package_batches (preparation_id, offset, end_offset, assets_json)
      SELECT ?, ?, ?, ? WHERE ${currentGuard}
      AND EXISTS (SELECT 1 FROM admin_draft_package_preparations WHERE draft_id = ? AND id = ? AND allocation_sha256 = ? AND expires_at > unixepoch('now'))
      AND COALESCE((SELECT MAX(end_offset) FROM admin_draft_package_batches WHERE preparation_id = ?), 0) = ?
      ON CONFLICT(preparation_id, offset) DO NOTHING`).bind(job.id, input.offset, end, JSON.stringify(assets),
      ...guardArgs(row, principal, snapshot), row.id, job.id, snapshot.sha256, job.id, input.offset).run();
    if (!changed(saved)) {
      const latest = await getPreparation(env, row);
      if (latest?.id !== job.id || !(await batchRows(env, job)).results.some(batch => batch.offset === input.offset)) fail(409, 'PACKAGE_CHANGED', 'Draft or preparation changed during inspection. Refresh and restart.');
    }
    const latest = await getPreparation(env, row);
    if (latest?.id !== job.id) fail(409, 'PACKAGE_CHANGED', 'Preparation changed during inspection. Refresh and restart.');
    // Also revalidate current allocations on concurrent/lost-response retries.
    return reply(await resultFor(env, row, latest, await currentSnapshot(env, row, principal, latest)));
  }
  if (progress.end !== snapshot.assets.length) fail(409, 'PACKAGE_INCOMPLETE', 'Check every batch before finishing the package.');
  const assets = progress.results.flatMap(batch => JSON.parse(batch.assets_json));
  if (assets.length !== snapshot.assets.length || assets.some((asset, index) => {
    const allocated = snapshot.assets[index];
    return asset.assetId !== allocated.assetId || asset.path !== allocated.path || asset.objectKey !== allocated.objectKey
      || asset.byteLength !== allocated.byteLength || asset.sha256 !== allocated.sha256 || typeof asset.etag !== 'string' || !asset.etag;
  })) fail(409, 'PACKAGE_PROGRESS', 'Recorded files no longer match the preparation. Restart it.');
  const reviewSnapshot = { draftId: row.id, manifest: snapshot.manifest, assets }, hash = await jsonSha256(reviewSnapshot);
  if (new TextEncoder().encode(JSON.stringify(reviewSnapshot)).length > REVIEW_PACKAGE_BYTES - 2048) fail(413, 'PACKAGE_SIZE', 'Review package exceeds its metadata limit.');
  await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_draft_review_jobs (draft_id, id, snapshot_json, snapshot_sha256, expires_at)
    SELECT ?, ?, ?, ?, ? WHERE ${currentGuard}
    AND EXISTS (SELECT 1 FROM admin_draft_package_preparations WHERE draft_id = ? AND id = ? AND allocation_sha256 = ? AND expires_at > unixepoch('now'))
    ON CONFLICT(draft_id) DO UPDATE SET id = excluded.id, snapshot_json = excluded.snapshot_json,
      snapshot_sha256 = excluded.snapshot_sha256, expires_at = excluded.expires_at
    WHERE admin_draft_review_jobs.id != excluded.id OR admin_draft_review_jobs.snapshot_sha256 != excluded.snapshot_sha256`)
    .bind(row.id, job.id, JSON.stringify(reviewSnapshot), hash, job.expires_at, ...guardArgs(row, principal, snapshot), row.id, job.id, snapshot.sha256).run();
  const reviewJob = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_review_jobs WHERE draft_id = ?').bind(row.id).first();
  const latest = await getPreparation(env, row);
  if (latest?.id !== job.id || !latest.unexpired || reviewJob?.id !== job.id || reviewJob.snapshot_sha256 !== hash) fail(409, 'PACKAGE_CHANGED', 'Preparation changed or expired while finishing. Refresh and restart.');
  // A concurrent archive/attestation must not be treated as a successful finish retry.
  return reply({ ...await resultFor(env, row, latest, await currentSnapshot(env, row, principal, latest)), package: packageFor(reviewJob) });
}
