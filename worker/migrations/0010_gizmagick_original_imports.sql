-- Initial original-library intake only. No version, public pointer or catalog
-- visibility is created here. Existing new-track publishers reject reserved IDs.
ALTER TABLE admin_drafts ADD COLUMN original_legacy_key TEXT CHECK (original_legacy_key IS NULL OR length(original_legacy_key) > 0);

CREATE TABLE admin_original_imports (
  draft_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_drafts(id),
  track_id TEXT UNIQUE NOT NULL REFERENCES library_tracks(id),
  legacy_key TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL CHECK (length(source_version_id) = 36),
  source_manifest_sha256 TEXT NOT NULL CHECK (length(source_manifest_sha256) = 64),
  source_manifest_json TEXT NOT NULL CHECK (json_valid(source_manifest_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (json_extract(source_manifest_json, '$.track.id') IS track_id),
  CHECK (json_extract(source_manifest_json, '$.versionId') IS source_version_id)
);

-- Final INSERT of the atomic three-statement batch. A failure rolls back the
-- private library identity AND draft, including races with existing reservations.
CREATE TRIGGER admin_original_import_guard BEFORE INSERT ON admin_original_imports
WHEN NOT EXISTS (
  SELECT 1 FROM library_tracks t JOIN admin_drafts d ON d.id = NEW.draft_id
  WHERE t.id = NEW.track_id AND t.legacy_key = NEW.legacy_key AND t.owner_id = NEW.owner_id
    AND t.visibility = 'private' AND t.status = 'draft' AND t.current_version_id IS NULL
    AND d.owner_id = NEW.owner_id AND d.original_legacy_key = NEW.legacy_key AND d.status = 'draft'
    AND json_extract(d.manifest_json, '$.track.id') = NEW.track_id
    AND json_extract(d.manifest_json, '$.versionId') != NEW.source_version_id
    AND json_remove(d.manifest_json, '$.versionId') = json_remove(NEW.source_manifest_json, '$.versionId')
) OR EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = NEW.track_id)
  OR EXISTS (SELECT 1 FROM admin_drafts WHERE id != NEW.draft_id AND json_extract(manifest_json, '$.track.id') = NEW.track_id)
  OR EXISTS (SELECT 1 FROM admin_publications WHERE track_id = NEW.track_id)
  OR EXISTS (SELECT 1 FROM admin_publication_intent_preparations WHERE json_extract(plan_json, '$.candidate.track.id') = NEW.track_id)
BEGIN SELECT RAISE(ABORT, 'Original library identity conflicts with an existing reservation'); END;

CREATE TRIGGER admin_original_draft_quota BEFORE INSERT ON admin_drafts
WHEN NEW.original_legacy_key IS NOT NULL
  AND (SELECT COUNT(*) FROM admin_drafts WHERE owner_id = NEW.owner_id AND status = 'draft') >= 20
BEGIN SELECT RAISE(ABORT, 'Original library intake active draft quota'); END;

CREATE TRIGGER admin_original_import_immutable_update BEFORE UPDATE ON admin_original_imports
BEGIN SELECT RAISE(ABORT, 'Original import provenance is immutable'); END;
CREATE TRIGGER admin_original_import_immutable_delete BEFORE DELETE ON admin_original_imports
BEGIN SELECT RAISE(ABORT, 'Original import provenance is retained'); END;
CREATE TRIGGER admin_original_draft_identity BEFORE UPDATE ON admin_drafts
WHEN OLD.original_legacy_key IS NOT NULL AND (
  NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.request_id IS NOT OLD.request_id
  OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.original_legacy_key IS NOT OLD.original_legacy_key
  OR json_extract(NEW.manifest_json, '$.track.id') IS NOT json_extract(OLD.manifest_json, '$.track.id')
  OR json_extract(NEW.manifest_json, '$.versionId') IS NOT json_extract(OLD.manifest_json, '$.versionId'))
BEGIN SELECT RAISE(ABORT, 'Original private draft identity is immutable'); END;
CREATE TRIGGER admin_original_library_identity BEFORE UPDATE ON library_tracks
WHEN EXISTS (SELECT 1 FROM admin_original_imports WHERE track_id = OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.legacy_key IS NOT OLD.legacy_key)
BEGIN SELECT RAISE(ABORT, 'Original library owner and compatibility mapping are immutable'); END;
