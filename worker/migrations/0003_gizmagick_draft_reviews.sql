-- One pending package and one immutable human attestation per new-track draft.
-- No publication pointers or client-controlled server-decoded flags.
CREATE TABLE admin_draft_review_jobs (
  draft_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_drafts(id),
  id TEXT UNIQUE NOT NULL CHECK (length(id) = 36),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE admin_draft_reviews (
  draft_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_drafts(id),
  job_id TEXT UNIQUE NOT NULL REFERENCES admin_draft_review_jobs(id),
  approved_by TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy = 'gizmagick-local-admin-v1'),
  scope TEXT NOT NULL CHECK (scope = 'administrator-attested'),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  report_sha256 TEXT NOT NULL CHECK (length(report_sha256) = 64),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
