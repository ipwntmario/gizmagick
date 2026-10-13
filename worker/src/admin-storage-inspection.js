import checkStructure from './generated/manifest-validator.js';
import { validateManifestWithStructure } from '../../shared/track-manifest.js';
import { jsonSha256 } from '../../shared/draft-review.js';
import { DraftError, DRAFT_LIMITS } from './admin-drafts.js';

export const STORAGE_INSPECTION_BATCH_SIZE = 16;
const fail = (status, code, message) => { throw new DraftError(status, code, message); };
const hashPattern = /^[a-f0-9]{64}$/;

// Pins database allocations, not an atomic snapshot of R2 across requests.
async function allocationSnapshot(env, row) {
  if (row.status !== 'draft') fail(409, 'INSPECTION_ARCHIVED', 'Only active drafts can be inspected.');
  if (new TextEncoder().encode(row.manifest_json).length > DRAFT_LIMITS.metadataBytes) fail(409, 'INSPECTION_METADATA', 'Draft metadata exceeds the inspection limit.');
  let manifest;
  try { manifest = JSON.parse(row.manifest_json); } catch { fail(409, 'INSPECTION_METADATA', 'Draft metadata is invalid.'); }
  if (!validateManifestWithStructure(manifest, checkStructure).valid
      || Object.keys(manifest.assets).length > DRAFT_LIMITS.assets
      || Object.keys(manifest.clips).length > DRAFT_LIMITS.clips
      || Object.keys(manifest.sections).length > DRAFT_LIMITS.sections) fail(409, 'INSPECTION_METADATA', 'Draft metadata no longer passes validation.');
  const { results } = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_draft_assets WHERE draft_id = ? ORDER BY asset_id LIMIT ?')
    .bind(row.id, DRAFT_LIMITS.assets + 1).all();
  if (results.length !== Object.keys(manifest.assets).length || results.some(asset => {
    const declared = manifest.assets[asset.asset_id];
    return !declared || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.byte_length)
      || asset.byte_length < 1 || asset.byte_length > DRAFT_LIMITS.audioBytes || !hashPattern.test(asset.sha256)
      || typeof asset.object_key !== 'string' || !asset.object_key.startsWith(`drafts/${row.id}/assets/`)
      || (declared.byteLength !== undefined && declared.byteLength !== asset.byte_length)
      || (declared.sha256 !== undefined && declared.sha256 !== asset.sha256);
  })) fail(409, 'INSPECTION_INCOMPLETE', 'Every referenced file must have a complete, matching private upload allocation.');
  const assets = results.map(asset => ({ assetId: asset.asset_id, path: manifest.assets[asset.asset_id].path,
    objectKey: asset.object_key, byteLength: asset.byte_length, sha256: asset.sha256, state: asset.state }));
  return { manifest, assets, sha256: await jsonSha256({ draftId: row.id, manifest, assets }) };
}

export async function inspectPrivateStorage(request, env, principal, row) {
  if (principal.role !== 'admin') fail(403, 'INSPECTION_ADMIN_ONLY', 'Only a verified administrator can inspect private storage.');
  if (row.owner_id !== principal.id) fail(404, 'DRAFT_NOT_FOUND', 'Draft not found.');
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['offset', 'snapshot'].includes(key))
      || params.getAll('offset').length !== 1 || params.getAll('snapshot').length > 1
      || !/^(0|[1-9]\d{0,2})$/.test(params.get('offset'))) fail(400, 'INSPECTION_QUERY', 'Supply one valid batch offset and only the optional snapshot checksum.');
  const offset = Number(params.get('offset')), pin = params.get('snapshot');
  if (offset % STORAGE_INSPECTION_BATCH_SIZE || (pin !== null && !hashPattern.test(pin)) || (offset > 0 && pin === null)) {
    fail(400, 'INSPECTION_QUERY', 'Later batches require the allocation checksum from the first batch.');
  }
  const snapshot = await allocationSnapshot(env, row);
  if (pin !== null && pin !== snapshot.sha256) fail(409, 'INSPECTION_STALE', 'Metadata or allocations changed. Reopen the draft and restart inspection.');
  if (offset >= snapshot.assets.length) fail(400, 'INSPECTION_QUERY', 'Batch offset is outside this draft.');
  const end = Math.min(offset + STORAGE_INSPECTION_BATCH_SIZE, snapshot.assets.length), assets = [];
  for (const asset of snapshot.assets.slice(offset, end)) {
    const object = await env.GIZMAGICK_DRAFTS.head(asset.objectKey);
    const checksum = object?.checksums?.sha256;
    const storedHash = checksum ? Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, '0')).join('') : null;
    if (!object || !object.etag || object.size !== asset.byteLength
        || object.customMetadata?.sha256 !== asset.sha256 || storedHash !== asset.sha256) {
      fail(409, 'INSPECTION_STORAGE', 'A private file in this batch is missing or changed. Reopen the draft and restart inspection.');
    }
    assets.push({ assetId: asset.assetId, path: asset.path, byteLength: asset.byteLength, sha256: asset.sha256, etag: object.etag });
  }
  const latest = await env.GIZMAGICK_DB.prepare('SELECT * FROM admin_drafts WHERE id = ? AND owner_id = ?').bind(row.id, principal.id).first();
  if (!latest || latest.status !== 'draft' || (await allocationSnapshot(env, latest)).sha256 !== snapshot.sha256) {
    fail(409, 'INSPECTION_STALE', 'The draft changed during inspection. Reopen it and restart.');
  }
  return { inspectionVersion: 1, scope: 'private-storage-batch', draftId: row.id,
    trackId: snapshot.manifest.track.id, versionId: snapshot.manifest.versionId,
    manifestSha256: await jsonSha256(snapshot.manifest), allocationSha256: snapshot.sha256,
    batch: { offset, end, totalAssets: snapshot.assets.length, nextOffset: end < snapshot.assets.length ? end : null },
    assets, checksPassed: true, batchOnly: true, pointInTimeOnly: true,
    audioProbed: false, publishing: false, publicationAuthorized: false };
}
