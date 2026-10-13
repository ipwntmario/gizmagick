-- Temporary preparation state only, not an attestation or publication receipt.
-- One resumable preparation per draft. Replacing it invalidates its old batches.
CREATE TABLE admin_draft_package_preparations (
  draft_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_drafts(id),
  id TEXT UNIQUE NOT NULL CHECK (length(id) = 36),
  allocation_json TEXT NOT NULL CHECK (json_valid(allocation_json)),
  allocation_sha256 TEXT NOT NULL CHECK (length(allocation_sha256) = 64),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE admin_draft_package_batches (
  preparation_id TEXT NOT NULL REFERENCES admin_draft_package_preparations(id),
  offset INTEGER NOT NULL CHECK (offset >= 0 AND offset % 16 = 0 AND offset <= 240),
  end_offset INTEGER NOT NULL CHECK (end_offset > offset AND end_offset <= offset + 16 AND end_offset <= 256),
  assets_json TEXT NOT NULL CHECK (json_valid(assets_json) AND json_type(assets_json) = 'array'
    AND json_array_length(assets_json) = end_offset - offset),
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (preparation_id, offset)
);

CREATE TRIGGER admin_package_replace_batches BEFORE UPDATE OF id ON admin_draft_package_preparations
WHEN OLD.id != NEW.id
BEGIN
  DELETE FROM admin_draft_package_batches WHERE preparation_id = OLD.id;
  DELETE FROM admin_draft_review_jobs WHERE id = OLD.id
    AND NOT EXISTS (SELECT 1 FROM admin_draft_reviews WHERE job_id = OLD.id);
END;
