import { UUID_PATTERN } from '../../shared/library-contract.js';
import { jsonSha256 } from '../../shared/draft-review.js';
import { DraftError, readBoundedBody } from './admin-drafts.js';
import { boundedCopyEnabled, checkedStored, copyProgress, reviewedIntentPlan, guard, guardArgs } from './admin-publication-intents.js';
import { inspectAllocationAssets } from './admin-storage-inspection.js';
import { verifyPublic, PUBLICATION_LIMITS } from './admin-publications.js';

export const boundedFinalEnabled = env => boundedCopyEnabled(env) && env.GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED === 'true';
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);
const uuid = value => typeof value === 'string' && UUID_PATTERN.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const passFor = (env, intent) => env.GIZMAGICK_DB.prepare('SELECT *, expires_at > unixepoch(\'now\') AS unexpired FROM admin_publication_final_passes WHERE publication_id = ?').bind(intent.id).first();

async function schema(env) {
  const ready = await env.GIZMAGICK_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'admin_bounded_final_commit_guard'").first();
  if (!ready) fail(503, 'FINAL_SCHEMA', 'Final publication needs migration 0009. No catalog change was attempted.');
}
async function progressFor(env, pass, total) {
  const { results } = await env.GIZMAGICK_DB.prepare(`SELECT *, (checked_at BETWEEN unixepoch('now') - 300 AND unixepoch('now')
    AND finished_at BETWEEN checked_at AND unixepoch('now')) AS recent
    FROM admin_publication_final_batches WHERE pass_id = ? ORDER BY offset LIMIT 18`).bind(pass.id).all();
  let end = 0;
  for (const batch of results) {
    if (batch.offset !== end || batch.end_offset !== Math.min(end + 16, total) || end >= total) fail(409, 'FINAL_PROGRESS', 'Final-check progress is inconsistent. Explicitly restart verification.');
    end = batch.end_offset;
  }
  return { end, recent: results.every(batch => batch.recent), first: results.length ? Math.min(...results.map(batch => batch.checked_at)) : null,
    last: results.length ? Math.max(...results.map(batch => batch.finished_at)) : null, results };
}
async function statusFor(env, row, intent, plan) {
  const receipts = await copyProgress(env, intent, plan), commit = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_publication_commits WHERE publication_id = ?').bind(intent.id).first();
  if ((intent.state === 'published') !== Boolean(commit)) fail(409, 'FINAL_PROGRESS', 'Publication state and commit audit disagree.');
  const pass = await passFor(env, intent), progress = pass ? await progressFor(env, pass, plan.objects.length) : null;
  return { workflowVersion: 1, catalogCommitEnabled: true, publicationAuthorized: false, serverDecoded: false, pointInTimeBatches: true,
    publication: { id: intent.id, draftId: row.id, trackId: intent.track_id, versionId: intent.version_id,
      planSha256: intent.plan_sha256, state: intent.state, copiedObjects: receipts.length, totalObjects: plan.objects.length,
      ...(plan.originalImport ? { originalImport: plan.originalImport } : {}),
      publishedAt: commit?.published_at ?? null, finalAudit: commit ? { passId: commit.final_pass_id,
        storageCheckScope: commit.storage_check_scope, checkedFrom: commit.storage_checked_from, checkedUntil: commit.storage_checked_until } : null },
    verification: pass ? { id: pass.id, requestId: pass.request_id, publicationId: intent.id, planSha256: pass.plan_sha256,
      receiptsSha256: pass.receipts_sha256, checkedObjects: progress.end, totalObjects: plan.objects.length, expiresAt: pass.expires_at,
      recent: Boolean(pass.unexpired && progress.recent), firstCheckedAt: progress.first, lastCheckedAt: progress.last } : null };
}
async function inputFor(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'FINAL_JSON', 'Send application/json.');
  const bytes = await readBoundedBody(request, 2048); let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'FINAL_INPUT', 'Invalid UTF-8 JSON.'); }
  const keys = { start: ['action', 'publicationId', 'expectedPlanSha256', 'requestId', 'restartPassId'],
    'check-batch': ['action', 'publicationId', 'expectedPlanSha256', 'passId', 'offset'],
    commit: ['action', 'publicationId', 'expectedPlanSha256', 'passId', 'publicationConfirmed', 'batchWindowConfirmed'] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(keys, input.action)
      || Object.keys(input).some(key => !keys[input.action].includes(key)) || !uuid(input.publicationId) || !sha(input.expectedPlanSha256)
      || (input.action === 'start' && (!uuid(input.requestId) || (input.restartPassId !== undefined && !uuid(input.restartPassId))))
      || (input.action !== 'start' && !uuid(input.passId))
      || (input.action === 'check-batch' && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 256 || input.offset % 16))
      || (input.action === 'commit' && (input.publicationConfirmed !== true || input.batchWindowConfirmed !== true))) fail(400, 'FINAL_INPUT', 'Use the exact publication, plan and final pass, with separate publication and batch-window confirmations.');
  return input;
}
// Reconstruct current D1 authority without making an all-file storage request.
async function currentFor(env, principal, row, intent) {
  const current = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!current) fail(404, 'FINAL_NOT_FOUND', 'Draft not found.');
  const checked = await reviewedIntentPlan(env, principal, current);
  if (checked.planHash !== intent.plan_sha256) fail(409, 'FINAL_CHANGED', 'The exact reviewed plan, media base or allocations changed.');
  const receipts = await copyProgress(env, intent, checked.plan);
  if (receipts.length !== checked.plan.objects.length) fail(409, 'FINAL_COPIES', 'Every public copy must be recorded before starting final verification.');
  return { current, checked, receipts, receiptsJson: JSON.stringify(receipts), receiptsHash: await jsonSha256(receipts) };
}
const passGuard = `EXISTS (SELECT 1 FROM admin_publication_final_passes f JOIN admin_publications p ON p.id = f.publication_id
  WHERE f.id = ? AND f.publication_id = ? AND f.owner_id = ? AND f.plan_sha256 = ? AND f.receipts_sha256 = ? AND f.receipts_json = ?
    AND f.expires_at > unixepoch('now') AND p.state = 'pending' AND p.lease_token = ? AND p.lease_expires_at > unixepoch('now'))`;
const passArgs = (pass, intent, snapshot, token) => [pass.id, intent.id, intent.owner_id, intent.plan_sha256, snapshot.receiptsHash, snapshot.receiptsJson, token];

export async function handleFinalRequest(request, env, principal, row, reply, headers) {
  if (!boundedFinalEnabled(env)) return reply({ error: 'Bounded final publication is disabled.', code: 'FINAL_DISABLED' }, 503);
  if (principal.role !== 'admin') fail(403, 'FINAL_ADMIN', 'Only a verified administrator can finalize their own publication.');
  if (new URL(request.url).search) fail(400, 'FINAL_INPUT', 'Final operations do not accept query parameters.');
  await schema(env);
  const intent = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_publications WHERE draft_id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!intent) fail(404, 'FINAL_NOT_FOUND', 'Reserve a version-2 publication intent first.');
  const plan = await checkedStored(intent);
  if (['GET', 'HEAD'].includes(request.method)) return reply(await statusFor(env, row, intent, plan));
  if (request.method !== 'POST') { headers.set('Allow', 'GET, HEAD, POST'); return reply({ error: 'Method not allowed', code: 'FINAL_METHOD' }, 405); }
  const input = await inputFor(request);
  if (input.publicationId !== intent.id || input.expectedPlanSha256 !== intent.plan_sha256) fail(409, 'FINAL_IDENTITY', 'Refresh the exact intent and plan before continuing.');
  let pass = await passFor(env, intent);
  if (intent.state === 'published') {
    const commit = await env.GIZMAGICK_DB.prepare('SELECT final_pass_id FROM admin_publication_commits WHERE publication_id = ?').bind(intent.id).first();
    if (input.action === 'commit' && input.passId === commit?.final_pass_id) return reply(await statusFor(env, row, intent, plan));
    fail(409, 'FINAL_PUBLISHED', 'This exact track/version is already published. No further writes are allowed.');
  }
  const snapshot = await currentFor(env, principal, row, intent), db = env.GIZMAGICK_DB;
  const token = crypto.randomUUID();
  const locked = await db.prepare(`UPDATE admin_publications SET lease_token = ?, lease_expires_at = unixepoch('now') + ?
    WHERE id = ? AND owner_id = ? AND state = 'pending' AND lease_expires_at <= unixepoch('now')`).bind(token, PUBLICATION_LIMITS.leaseSeconds, intent.id, principal.id).run();
  if (!changed(locked)) fail(409, 'FINAL_BUSY', 'Another publication step is running. Refresh status; interrupted leases expire after two minutes.');
  try {
    const leaseGuard = `EXISTS (SELECT 1 FROM admin_publications WHERE id = ? AND state = 'pending' AND lease_token = ? AND lease_expires_at > unixepoch('now'))`;
    const leaseArgs = [intent.id, token];
    if (input.action === 'start') {
      pass = await passFor(env, intent);
      if (input.restartPassId && input.restartPassId !== pass?.id) fail(409, 'FINAL_CHANGED', 'Refresh the current final pass before restarting.');
      if (pass?.unexpired && pass.request_id !== input.requestId && !input.restartPassId) fail(409, 'FINAL_REQUEST', 'Reuse the refreshed request ID or explicitly restart this pass.');
      const saved = await db.prepare(`INSERT INTO admin_publication_final_passes
        (publication_id, id, request_id, owner_id, plan_sha256, receipts_json, receipts_sha256, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, unixepoch('now') + 900 WHERE ${guard(snapshot.checked)} AND ${leaseGuard}
        ON CONFLICT(publication_id) DO UPDATE SET id = excluded.id, request_id = excluded.request_id,
          owner_id = excluded.owner_id, plan_sha256 = excluded.plan_sha256, receipts_json = excluded.receipts_json,
          receipts_sha256 = excluded.receipts_sha256, expires_at = excluded.expires_at, created_at = unixepoch('now')
        WHERE admin_publication_final_passes.expires_at <= unixepoch('now') OR admin_publication_final_passes.id = ?
          OR EXISTS (SELECT 1 FROM admin_publication_final_batches WHERE pass_id = admin_publication_final_passes.id
            AND (checked_at < unixepoch('now') - 300 OR checked_at > unixepoch('now') OR finished_at < checked_at OR finished_at > unixepoch('now')))`)
        .bind(intent.id, crypto.randomUUID(), input.requestId, principal.id, intent.plan_sha256, snapshot.receiptsJson, snapshot.receiptsHash,
          ...guardArgs(snapshot.current, snapshot.checked), ...leaseArgs, input.restartPassId || '').run();
      pass = await passFor(env, intent);
      if (!pass || pass.request_id !== input.requestId || pass.receipts_sha256 !== snapshot.receiptsHash || (input.restartPassId && !changed(saved))) fail(409, 'FINAL_CHANGED', 'The draft or verification pass changed before starting.');
      const currentGuard = await db.prepare(`SELECT id FROM admin_publications WHERE id = ? AND ${guard(snapshot.checked)} AND ${leaseGuard}`)
        .bind(intent.id, ...guardArgs(snapshot.current, snapshot.checked), ...leaseArgs).first();
      if (!currentGuard) fail(409, 'FINAL_CHANGED', 'The current review, allocations or lease changed while preparing final checks.');
      return reply(await statusFor(env, snapshot.current, intent, plan), changed(saved) ? 201 : 200);
    }
    pass = await passFor(env, intent);
    if (!pass?.unexpired || pass.id !== input.passId || pass.plan_sha256 !== intent.plan_sha256
        || pass.receipts_sha256 !== snapshot.receiptsHash || pass.receipts_json !== snapshot.receiptsJson) fail(409, 'FINAL_PASS', 'Refresh or explicitly restart the exact current final verification pass.');
    const progress = await progressFor(env, pass, plan.objects.length);
    if (!progress.recent) fail(409, 'FINAL_OLD_CHECKS', 'Checks are over five minutes old. Explicitly start a fresh final pass.');
    if (input.action === 'check-batch') {
      if (progress.results.some(batch => batch.offset === input.offset)) return reply(await statusFor(env, snapshot.current, intent, plan));
      if (input.offset !== progress.end || input.offset >= plan.objects.length) fail(409, 'FINAL_OFFSET', 'Only the next unchecked final batch may run.');
      const end = Math.min(input.offset + 16, plan.objects.length), selected = plan.objects.slice(input.offset, end);
      // Use D1's clock before the first storage read. Completion cannot make
      // earlier HEADs look younger, and the audit retains the enclosing interval.
      const { checkedAt } = await db.prepare("SELECT unixepoch('now') AS checkedAt").first();
      const sources = selected.filter(object => object.kind === 'audio').map(object => snapshot.checked.allocation.assets.find(asset => asset.assetId === object.assetId));
      const actual = await inspectAllocationAssets(env, sources);
      if (actual.some(asset => asset.etag !== plan.sources.find(source => source.assetId === asset.assetId).etag)) fail(409, 'FINAL_SOURCE', 'A private source changed since its administrator review.');
      for (let ordinal = input.offset; ordinal < end; ordinal++) verifyPublic(await env.GIZMAGICK_MEDIA.head(plan.objects[ordinal].key), plan.objects[ordinal], intent, snapshot.receipts[ordinal]);
      await db.prepare(`INSERT INTO admin_publication_final_batches (pass_id, offset, end_offset, checked_at)
        SELECT ?, ?, ?, ? WHERE ${guard(snapshot.checked)} AND ${passGuard} AND ? BETWEEN unixepoch('now') - 300 AND unixepoch('now')
        AND COALESCE((SELECT MAX(end_offset) FROM admin_publication_final_batches WHERE pass_id = ?), 0) = ?
        ON CONFLICT(pass_id, offset) DO NOTHING`).bind(pass.id, input.offset, end, checkedAt, ...guardArgs(snapshot.current, snapshot.checked),
          ...passArgs(pass, intent, snapshot, token), checkedAt, pass.id, input.offset).run();
      if (!(await progressFor(env, pass, plan.objects.length)).results.some(batch => batch.offset === input.offset)) fail(409, 'FINAL_CHANGED', 'The final batch could not be recorded under this exact draft, review, pass and lease.');
      return reply(await statusFor(env, snapshot.current, intent, plan));
    }
    if (progress.end !== plan.objects.length) fail(409, 'FINAL_INCOMPLETE', 'Freshly verify every private source and public copy before confirming catalog publication.');
    // No unbounded storage loop at commit. The immutable receipt identity,
    // recent batch window and all D1 authority are fenced in one transaction.
    try {
      await db.prepare(`INSERT INTO admin_publication_commits
        (publication_id, lease_token, final_pass_id, storage_check_scope, storage_checked_from, storage_checked_until)
        VALUES (?, ?, ?, 'bounded-batches', ?, ?)`).bind(intent.id, token, pass.id, Math.min(...progress.results.map(batch => batch.checked_at)), progress.last).run();
    } catch (error) {
      if (/Bounded final verification changed|Publication changed before commit/.test(String(error.message))) fail(409, 'FINAL_CHANGED', 'The draft, review, lease, final pass, recent checks or catalog identity changed before commit. Refresh status.');
      throw error;
    }
    return reply(await statusFor(env, snapshot.current, { ...intent, state: 'published' }, plan));
  } finally {
    await db.prepare("UPDATE admin_publications SET lease_token = NULL, lease_expires_at = 0 WHERE id = ? AND state = 'pending' AND lease_token = ?").bind(intent.id, token).run();
  }
}
