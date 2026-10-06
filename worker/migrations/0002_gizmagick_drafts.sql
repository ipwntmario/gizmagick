-- Private intake only: no foreign keys or pointers into the published catalog.
CREATE TABLE admin_drafts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  title TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(owner_id, request_id)
);
CREATE INDEX admin_drafts_owner ON admin_drafts(owner_id, status, created_at);

CREATE TABLE admin_draft_assets (
  draft_id TEXT NOT NULL REFERENCES admin_drafts(id),
  asset_id TEXT NOT NULL,
  object_key TEXT UNIQUE NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploaded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(draft_id, asset_id),
  CHECK (substr(object_key, 1, 51) = 'drafts/' || draft_id || '/assets/')
);
