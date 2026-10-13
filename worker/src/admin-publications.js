import { UUID_PATTERN, normalizeMediaBase } from '../../shared/library-contract.js';
import { jsonSha256 } from '../../shared/draft-review.js';
import { DraftError, readBoundedBody } from './admin-drafts.js';
import { inspectReviewedDraft, requireNewLibraryIdentity, publicationPreflightEnabled } from './admin-publication-preview.js';

export const PUBLICATION_LIMITS = Object.freeze({ assets: 16, inputBytes: 2048, planBytes: 1048576, leaseSeconds: 120 });
export const publishingEnabled = env => env.GIZMAGICK_PUBLICATION_ENABLED === 'true' && publicationPreflightEnabled(env);
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const changed = result => Number(result.meta?.changes ?? result.changes ?? 0);
const uuid = value => typeof value === 'string' && UUID_PATTERN.test(value);
const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha256 = object => object?.checksums?.sha256
  ? Array.from(new Uint8Array(object.checksums.sha256), byte => byte.toString(16).padStart(2, '0')).join('') : null;

function requireSmallDraft(row) {
  if (Object.keys(JSON.parse(row.manifest_json).assets).length > PUBLICATION_LIMITS.assets) {
    fail(422, 'PUBLICATION_LIMIT', 'This initial publisher supports at most 16 audio files. Larger tracks need the later batched publisher.');
  }
}

function planFor(env, row, checked) {
  const { candidate, snapshot, review, job, objects } = checked;
  return { planVersion: 1, draftId: row.id, ownerId: row.owner_id,
    mediaBase: normalizeMediaBase(env.GIZMAGICK_MEDIA_BASE_URL), manifestJson: row.manifest_json,
    candidate, candidateJson: review.candidate_json, snapshotJson: job.snapshot_json, reportJson: review.report_json,
    sources: snapshot.assets,
    review: { jobId: review.job_id, policy: review.policy, scope: review.scope,
      snapshotSha256: review.snapshot_sha256, reportSha256: review.report_sha256, manifestSha256: review.manifest_sha256 },
    // Copy audio first. The manifest is the last public object, then D1 commits.
    objects: [...objects.slice(1), objects[0]], warnings: checked.warnings };
}

async function inputFor(request, keys) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(415, 'PUBLICATION_JSON', 'Send application/json.');
  const bytes = await readBoundedBody(request, PUBLICATION_LIMITS.inputBytes);
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'PUBLICATION_JSON', 'Invalid UTF-8 JSON.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
      || input.publicationConfirmed !== true) {
    fail(400, 'PUBLICATION_CONFIRMATION', 'Explicit confirmation is required: copied files become public by URL before catalog publication and cannot be recalled by archiving a draft.');
  }
  return input;
}

const publicationFor = (env, row) => env.GIZMAGICK_DB.prepare('SELECT * FROM admin_publications WHERE draft_id = ? AND owner_id = ?').bind(row.id, row.owner_id).first();
const receiptsFor = (env, publication) => env.GIZMAGICK_DB.prepare('SELECT * FROM admin_publication_objects WHERE publication_id = ? ORDER BY ordinal').bind(publication.id).all();

async function checkedPlan(publication) {
  if (new TextEncoder().encode(publication.plan_json).length > PUBLICATION_LIMITS.planBytes) fail(409, 'PUBLICATION_PLAN', 'Stored publication plan exceeds its limit.');
  const plan = JSON.parse(publication.plan_json);
  if (plan.planVersion === 2 && await jsonSha256(plan) === publication.plan_sha256) {
    fail(409, 'PUBLICATION_BOUNDED_WORKFLOW', 'This is a bounded v2 intent. Public copying and final verification are not implemented for it yet; the legacy publisher cannot continue it.');
  }
  if (await jsonSha256(plan) !== publication.plan_sha256 || plan.planVersion !== 1
      || plan.ownerId !== publication.owner_id || plan.draftId !== publication.draft_id
      || plan.candidate.track.id !== publication.track_id || plan.candidate.versionId !== publication.version_id) {
    fail(409, 'PUBLICATION_PLAN', 'Stored publication audit no longer matches its identity or checksum.');
  }
  return plan;
}

async function summary(env, publication) {
  if (!publication) return { publication: null, limits: PUBLICATION_LIMITS };
  const plan = await checkedPlan(publication), { results } = await receiptsFor(env, publication);
  const commit = await env.GIZMAGICK_DB.prepare('SELECT published_at FROM admin_publication_commits WHERE publication_id = ?').bind(publication.id).first();
  return { publication: { id: publication.id, draftId: publication.draft_id, trackId: publication.track_id,
    versionId: publication.version_id, state: publication.state, createdAt: publication.created_at,
    publishedAt: commit?.published_at ?? null, copiedObjects: results.length, totalObjects: plan.objects.length,
    nextAction: publication.state === 'published' ? null : results.length < plan.objects.length ? 'copy-one-object' : 'verify-and-commit',
    scope: 'administrator-attested', serverDecoded: false,
    publicExposurePossible: true, planSha256: publication.plan_sha256 }, limits: PUBLICATION_LIMITS };
}

async function start(request, env, principal, row, reply) {
  const input = await inputFor(request, ['requestId', 'expectedSnapshotSha256', 'expectedReportSha256', 'publicationConfirmed']);
  if (!uuid(input.requestId) || !checksum(input.expectedSnapshotSha256)
      || !checksum(input.expectedReportSha256)) fail(400, 'PUBLICATION_INPUT', 'A UUID requestId and the exact reviewed snapshot/report checksums are required.');
  const existing = await publicationFor(env, row);
  if (existing) {
    const plan = await checkedPlan(existing);
    if (existing.request_id !== input.requestId || plan.review.snapshotSha256 !== input.expectedSnapshotSha256
        || plan.review.reportSha256 !== input.expectedReportSha256) fail(409, 'PUBLICATION_CONFLICT', 'This draft already has a different immutable publication intent.');
    if (existing.state !== 'published' && row.status !== 'draft') fail(409, 'PUBLICATION_ARCHIVED', 'Archived drafts cannot continue publication.');
    return reply(await summary(env, existing));
  }
  if (row.status !== 'draft') fail(409, 'PUBLICATION_ARCHIVED', 'Archived drafts cannot start publication.');
  requireSmallDraft(row);
  const checked = await inspectReviewedDraft(env, principal, row);
  if (checked.review.snapshot_sha256 !== input.expectedSnapshotSha256 || checked.review.report_sha256 !== input.expectedReportSha256) {
    fail(409, 'PUBLICATION_STALE', 'The requested review is not the exact current administrator attestation.');
  }
  await requireNewLibraryIdentity(env, checked.candidate);
  for (const object of checked.objects) {
    if (await env.GIZMAGICK_MEDIA.head(object.key)) fail(409, 'PUBLICATION_DESTINATION', 'A proposed public object already exists. Nothing will be overwritten or adopted.');
  }
  const plan = planFor(env, row, checked), document = JSON.stringify(plan);
  if (new TextEncoder().encode(document).length > PUBLICATION_LIMITS.planBytes) fail(413, 'PUBLICATION_PLAN_SIZE', 'Publication audit exceeds the initial publisher limit.');
  const planHash = await jsonSha256(plan), id = crypto.randomUUID();
  // Reserve only an intent; no library rows or public objects yet. Races against
  // archival/review changes are checked in this INSERT, not just earlier reads.
  await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_publications
    (id, draft_id, owner_id, request_id, track_id, version_id, plan_json, plan_sha256)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM admin_drafts d JOIN admin_draft_reviews r ON r.draft_id = d.id
      JOIN admin_draft_review_jobs j ON j.id = r.job_id AND j.draft_id = d.id
      WHERE d.id = ? AND d.owner_id = ? AND d.status = 'draft' AND d.manifest_json = ?
        AND r.approved_by = ? AND r.snapshot_sha256 = ? AND r.report_sha256 = ?
        AND r.policy = 'gizmagick-local-admin-v1' AND r.scope = 'administrator-attested'
        AND r.job_id = ? AND j.snapshot_sha256 = r.snapshot_sha256 AND r.manifest_sha256 = ?
        AND r.report_json = ? AND r.candidate_json = ? AND j.snapshot_json = ?)
    AND NOT EXISTS (SELECT 1 FROM library_tracks WHERE id = ?)
    ON CONFLICT DO NOTHING`).bind(id, row.id, principal.id, input.requestId, checked.candidate.track.id,
      checked.candidate.versionId, document, planHash, row.id, principal.id, row.manifest_json,
      principal.id, checked.review.snapshot_sha256, checked.review.report_sha256,
      checked.review.job_id, checked.review.manifest_sha256,
      checked.review.report_json, checked.review.candidate_json, checked.job.snapshot_json, checked.candidate.track.id).run();
  const saved = await publicationFor(env, row);
  if (!saved || saved.request_id !== input.requestId || saved.plan_sha256 !== planHash) fail(409, 'PUBLICATION_CONFLICT', 'The draft changed or another publication intent reserved this identity/request.');
  return reply(await summary(env, saved), saved.id === id ? 201 : 200);
}

function verifyPublic(object, expected, publication, receipt) {
  if (!object || !object.etag || object.size !== expected.byteLength || sha256(object) !== expected.sha256
      || object.customMetadata?.sha256 !== expected.sha256
      || object.customMetadata?.gizmagickPublication !== publication.id
      || object.customMetadata?.gizmagickPlan !== publication.plan_sha256
      || object.httpMetadata?.contentType !== (expected.kind === 'audio' ? 'audio/ogg' : 'application/json; charset=utf-8')
      || object.httpMetadata?.cacheControl !== 'public, max-age=31536000, immutable'
      || (receipt && receipt.etag !== object.etag)) {
    fail(409, 'PUBLICATION_DESTINATION', 'A public object is missing, changed, or does not belong to this exact publication. Nothing will be overwritten.');
  }
}

async function requireLease(env, row, publication, token) {
  const lease = await env.GIZMAGICK_DB.prepare(`SELECT id FROM admin_publications p WHERE p.id = ? AND p.state = 'pending'
    AND p.lease_token = ? AND p.lease_expires_at > unixepoch('now')
    AND EXISTS (SELECT 1 FROM admin_drafts WHERE id = p.draft_id AND owner_id = p.owner_id AND status = 'draft' AND manifest_json = ?)`)
    .bind(publication.id, token, row.manifest_json).first();
  if (!lease) fail(409, 'PUBLICATION_CHANGED', 'Publication lease expired or the draft changed. Reopen its status before retrying.');
}

async function copyOne(env, row, publication, plan, token, ordinal) {
  const expected = plan.objects[ordinal];
  let object = await env.GIZMAGICK_MEDIA.head(expected.key);
  if (!object) {
    let bytes;
    if (expected.kind === 'audio') {
      const source = plan.sources.find(asset => asset.assetId === expected.assetId);
      // Conditional GET closes the HEAD -> read race. Supply SHA-256 to R2 PUT
      // so R2 validates streamed bytes; don't buffer entire tracks in the Worker.
      const audio = await env.GIZMAGICK_DRAFTS.get(source.objectKey, { onlyIf: { etagMatches: source.etag } });
      if (!audio?.body || audio.etag !== source.etag || audio.size !== source.byteLength
          || sha256(audio) !== source.sha256 || audio.customMetadata?.sha256 !== source.sha256) {
        if (audio?.body) await audio.body.cancel();
        fail(409, 'PUBLICATION_SOURCE', 'Private audio changed before its conditional read.');
      }
      bytes = audio.body;
    } else bytes = new TextEncoder().encode(JSON.stringify(plan.candidate));
    try {
      await requireLease(env, row, publication, token);
      await env.GIZMAGICK_MEDIA.put(expected.key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: expected.sha256,
        httpMetadata: { contentType: expected.kind === 'audio' ? 'audio/ogg' : 'application/json; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { sha256: expected.sha256, gizmagickPublication: publication.id, gizmagickPlan: publication.plan_sha256 } });
    } catch (error) {
      if (bytes instanceof ReadableStream && !bytes.locked) await bytes.cancel().catch(() => {});
      throw error;
    }
    object = await env.GIZMAGICK_MEDIA.head(expected.key);
  }
  // A lost PUT response/receipt can be recovered only for our intent-marked,
  // native-checksummed object. Matching bytes from an unrelated upload are NOT enough.
  verifyPublic(object, expected, publication);
  await requireLease(env, row, publication, token);
  await env.GIZMAGICK_DB.prepare(`INSERT INTO admin_publication_objects (publication_id, ordinal, etag)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin_publications WHERE id = ? AND state = 'pending'
      AND lease_token = ? AND lease_expires_at > unixepoch('now'))
    ON CONFLICT(publication_id, ordinal) DO NOTHING`).bind(publication.id, ordinal, object.etag, publication.id, token).run();
  const receipt = await env.GIZMAGICK_DB.prepare('SELECT etag FROM admin_publication_objects WHERE publication_id = ? AND ordinal = ?').bind(publication.id, ordinal).first();
  if (!receipt || receipt.etag !== object.etag) fail(409, 'PUBLICATION_CHANGED', 'The copy was not recorded under the current lease. Its bytes may already be public.');
}

async function step(request, env, principal, row, reply) {
  const input = await inputFor(request, ['publicationId', 'publicationConfirmed']);
  if (!uuid(input.publicationId)) fail(400, 'PUBLICATION_INPUT', 'A UUID publicationId is required.');
  const publication = await publicationFor(env, row);
  if (!publication || publication.id !== input.publicationId) fail(404, 'PUBLICATION_NOT_FOUND', 'Publication not found.');
  if (JSON.parse(publication.plan_json).planVersion === 2) await checkedPlan(publication);
  if (publication.state === 'published') return reply(await summary(env, publication));
  if (row.status !== 'draft') fail(409, 'PUBLICATION_ARCHIVED', 'Archived drafts cannot continue publication. Copied files may remain public.');
  requireSmallDraft(row);
  const token = crypto.randomUUID(), db = env.GIZMAGICK_DB;
  const locked = await db.prepare(`UPDATE admin_publications SET lease_token = ?, lease_expires_at = unixepoch('now') + ?
    WHERE id = ? AND owner_id = ? AND state = 'pending' AND lease_expires_at <= unixepoch('now')`)
    .bind(token, PUBLICATION_LIMITS.leaseSeconds, publication.id, principal.id).run();
  if (!changed(locked)) fail(409, 'PUBLICATION_BUSY', 'Another step is running. Reopen status; after an interrupted request its lease expires in two minutes.');
  try {
    const plan = await checkedPlan(publication), checked = await inspectReviewedDraft(env, principal, row);
    if (await jsonSha256(planFor(env, row, checked)) !== publication.plan_sha256) fail(409, 'PUBLICATION_CHANGED', 'The current private review no longer matches this immutable publication intent.');
    await requireNewLibraryIdentity(env, checked.candidate);
    const { results } = await receiptsFor(env, publication);
    if (results.some((receipt, index) => receipt.ordinal !== index) || results.length > plan.objects.length) fail(409, 'PUBLICATION_RECEIPTS', 'Stored publication progress is inconsistent.');
    if (results.length < plan.objects.length) {
      await copyOne(env, row, publication, plan, token, results.length);
    } else {
      // Recheck ALL public destinations and the private snapshot on the final
      // step. Receipts alone or an earlier preview never authorize a pointer.
      for (let ordinal = 0; ordinal < plan.objects.length; ordinal++) {
        verifyPublic(await env.GIZMAGICK_MEDIA.head(plan.objects[ordinal].key), plan.objects[ordinal], publication, results[ordinal]);
      }
      await requireLease(env, row, publication, token);
      try {
        // Migration 0004's guarded trigger atomically inserts the track/version,
        // promotes the public pointer, records the immutable commit, and seals
        // the intent. Any failed guard/constraint rolls back the whole statement.
        await db.prepare('INSERT INTO admin_publication_commits (publication_id, lease_token) VALUES (?, ?)').bind(publication.id, token).run();
      } catch (error) {
        if (String(error.message).includes('Publication changed before commit')) fail(409, 'PUBLICATION_CHANGED', 'The draft, review, lease, allocations, or library changed before the atomic commit.');
        throw error;
      }
    }
    return reply(await summary(env, await publicationFor(env, row)));
  } finally {
    await db.prepare(`UPDATE admin_publications SET lease_token = NULL, lease_expires_at = 0 WHERE id = ? AND state = 'pending' AND lease_token = ?`).bind(publication.id, token).run();
  }
}

export async function handlePublicationRequest(request, env, principal, row, operation, reply, headers) {
  if (principal.role !== 'admin') fail(403, 'PUBLICATION_ADMIN', 'Only a verified administrator can publish their own attested new-track draft.');
  if (!publishingEnabled(env)) return reply({ error: 'Publication writes are not enabled.', code: 'PUBLICATION_DISABLED' }, 503);
  if (operation === 'publication' && ['GET', 'HEAD'].includes(request.method)) return reply(await summary(env, await publicationFor(env, row)));
  if (request.method !== 'POST') {
    headers.set('Allow', operation === 'publication' ? 'GET, HEAD, POST' : 'POST');
    return reply({ error: 'Method not allowed', code: 'PUBLICATION_METHOD' }, 405);
  }
  return operation === 'publication' ? start(request, env, principal, row, reply) : step(request, env, principal, row, reply);
}
