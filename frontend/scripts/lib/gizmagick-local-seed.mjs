import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { libraryVersionLocation } from '../../../shared/library-contract.js';
import { validateManifest } from './track-manifests.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function putImmutable(bucket, key, bytes, contentType) {
  const existing = await bucket.get(key);
  if (existing) {
    if (sha256(Buffer.from(await existing.arrayBuffer())) !== sha256(bytes)) throw new Error(`Refusing to overwrite immutable local object: ${key}`);
    return false;
  }
  await bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' } });
  const stored = await bucket.get(key);
  if (!stored || sha256(Buffer.from(await stored.arrayBuffer())) !== sha256(bytes)) throw new Error(`Local object verification failed: ${key}`);
  return true;
}

// Call only with LOCAL Miniflare bindings. This is not a production publisher:
// it has no remote flags, credentials, duration probing or admin authorization.
export async function seedLocalLibrary({ db, bucket, snapshot, publicRoot, onTrack = () => {} }) {
  let written = 0;
  for (const [name, entry] of Object.entries(snapshot.catalog.tracks)) {
    const document = snapshot.documents.get(entry.manifestUrl);
    const manifest = JSON.parse(document);
    const validation = validateManifest(manifest);
    if (!validation.valid) throw new Error(`Invalid local manifest for ${name}`);
    if (manifest.track.id !== entry.id || manifest.versionId !== entry.versionId) throw new Error(`Local catalog identity mismatch: ${name}`);
    const { prefix, manifestKey } = libraryVersionLocation(undefined, entry.id, entry.versionId);
    const digest = sha256(Buffer.from(document));
    const track = await db.prepare('SELECT legacy_key FROM library_tracks WHERE id = ?').bind(entry.id).first();
    if (track && track.legacy_key !== name) throw new Error(`Local track identity conflict: ${name}`);
    const version = await db.prepare('SELECT manifest_sha256 FROM library_track_versions WHERE track_id = ? AND version_id = ?').bind(entry.id, entry.versionId).first();
    if (version && version.manifest_sha256 !== digest) throw new Error(`Local version identity conflict: ${name}`);

    // No visible pointer changes until all objects exist and are verified.
    for (const asset of Object.values(manifest.assets)) {
      const bytes = await readFile(path.resolve(publicRoot, `.${entry.basePath}`, asset.path));
      if (bytes.length !== asset.byteLength || sha256(bytes) !== asset.sha256) throw new Error(`Audio changed after snapshot: ${name}/${asset.path}`);
      if (await putImmutable(bucket, `${prefix}/${asset.path}`, bytes, 'audio/ogg')) written++;
    }
    if (await putImmutable(bucket, manifestKey, Buffer.from(document), 'application/json')) written++;
    await db.batch([
      db.prepare(`INSERT INTO library_tracks (id, legacy_key, owner_id) VALUES (?, ?, 'gizmagick-admin-import') ON CONFLICT(id) DO NOTHING`).bind(entry.id, name),
      db.prepare(`INSERT INTO library_track_versions (track_id, version_id, manifest_key, manifest_sha256, schema_version, title, slug, first_section, simple, test)
        VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?) ON CONFLICT(track_id, version_id) DO NOTHING`).bind(entry.id, entry.versionId, manifestKey, digest, manifest.track.title, manifest.track.slug, manifest.track.firstSection, Number(manifest.track.simple), Number(manifest.track.test)),
      db.prepare(`UPDATE library_track_versions SET status = 'published' WHERE track_id = ? AND version_id = ? AND status = 'staged'`).bind(entry.id, entry.versionId),
      db.prepare(`UPDATE library_tracks SET current_version_id = ?, status = 'published', visibility = 'public', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(entry.versionId, entry.id),
    ]);
    onTrack(name);
  }
  return { tracks: Object.keys(snapshot.catalog.tracks).length, objectsWritten: written };
}
