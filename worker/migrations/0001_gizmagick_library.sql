-- Public library metadata only. Draft/editor documents belong in private storage.
CREATE TABLE library_tracks (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  legacy_key TEXT UNIQUE,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status != 'published' OR current_version_id IS NOT NULL),
  FOREIGN KEY (id, current_version_id) REFERENCES library_track_versions(track_id, version_id)
);

CREATE TABLE library_track_versions (
  track_id TEXT NOT NULL REFERENCES library_tracks(id),
  version_id TEXT NOT NULL CHECK (length(version_id) = 36),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'published')),
  manifest_key TEXT UNIQUE NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  first_section TEXT NOT NULL,
  simple INTEGER NOT NULL CHECK (simple IN (0, 1)),
  test INTEGER NOT NULL CHECK (test IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (track_id, version_id),
  CHECK (manifest_key = 'tracks/' || track_id || '/versions/' || version_id || '/manifest.json')
);

CREATE INDEX library_public_catalog ON library_tracks(visibility, status);

-- Once public, musical metadata cannot change under an existing version ID.
CREATE TRIGGER library_published_version_immutable
BEFORE UPDATE ON library_track_versions WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'Published Gizmagick versions are immutable');
END;
