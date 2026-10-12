-- Local-only publisher rollout. Applying this migration does not publish anything.
-- One immutable intent reserves each new-track identity and exact reviewed plan.
CREATE TABLE admin_publications (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  draft_id TEXT UNIQUE NOT NULL REFERENCES admin_drafts(id),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  track_id TEXT UNIQUE NOT NULL CHECK (length(track_id) = 36),
  version_id TEXT NOT NULL CHECK (length(version_id) = 36),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published')),
  lease_token TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner_id, request_id),
  CHECK (json_extract(plan_json, '$.draftId') = draft_id),
  CHECK (json_extract(plan_json, '$.ownerId') = owner_id),
  CHECK (json_extract(plan_json, '$.candidate.track.id') = track_id),
  CHECK (json_extract(plan_json, '$.candidate.versionId') = version_id)
);

CREATE TABLE admin_publication_objects (
  publication_id TEXT NOT NULL REFERENCES admin_publications(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  etag TEXT NOT NULL CHECK (length(etag) > 0),
  verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (publication_id, ordinal)
);

CREATE TABLE admin_publication_commits (
  publication_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_publications(id),
  lease_token TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER admin_publication_intent_immutable
BEFORE UPDATE OF id, draft_id, owner_id, request_id, track_id, version_id, plan_json, plan_sha256, created_at ON admin_publications
BEGIN SELECT RAISE(ABORT, 'Publication intents are immutable'); END;
CREATE TRIGGER admin_publication_no_delete BEFORE DELETE ON admin_publications
BEGIN SELECT RAISE(ABORT, 'Publication intents are retained'); END;
CREATE TRIGGER admin_publication_published_immutable BEFORE UPDATE ON admin_publications WHEN OLD.state = 'published'
BEGIN SELECT RAISE(ABORT, 'Published intents are immutable'); END;
CREATE TRIGGER admin_publication_state_guard BEFORE UPDATE OF state ON admin_publications
WHEN NEW.state != OLD.state AND NOT EXISTS (SELECT 1 FROM admin_publication_commits WHERE publication_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Publication requires an atomic commit'); END;

CREATE TRIGGER admin_publication_object_guard BEFORE INSERT ON admin_publication_objects
WHEN NOT EXISTS (SELECT 1 FROM admin_publications p WHERE p.id = NEW.publication_id AND p.state = 'pending'
  AND NEW.ordinal < json_array_length(p.plan_json, '$.objects'))
BEGIN SELECT RAISE(ABORT, 'Invalid publication object receipt'); END;
CREATE TRIGGER admin_publication_object_no_update BEFORE UPDATE ON admin_publication_objects
BEGIN SELECT RAISE(ABORT, 'Publication receipts are immutable'); END;
CREATE TRIGGER admin_publication_object_no_delete BEFORE DELETE ON admin_publication_objects
BEGIN SELECT RAISE(ABORT, 'Publication receipts are retained'); END;
CREATE TRIGGER admin_publication_commit_no_update BEFORE UPDATE ON admin_publication_commits
BEGIN SELECT RAISE(ABORT, 'Publication commits are immutable'); END;
CREATE TRIGGER admin_publication_commit_no_delete BEFORE DELETE ON admin_publication_commits
BEGIN SELECT RAISE(ABORT, 'Publication commits are retained'); END;

-- The final INSERT and all trigger writes are one SQLite transaction. A stale
-- lease, archival, changed review/allocation, identity collision, or SQL failure
-- aborts everything: no public pointer, staged library row, or commit is left.
CREATE TRIGGER admin_publication_commit_guard BEFORE INSERT ON admin_publication_commits
WHEN NOT EXISTS (
  SELECT 1 FROM admin_publications p JOIN admin_drafts d ON d.id = p.draft_id
  JOIN admin_draft_reviews r ON r.draft_id = p.draft_id
  JOIN admin_draft_review_jobs j ON j.id = r.job_id AND j.draft_id = p.draft_id
  WHERE p.id = NEW.publication_id AND p.state = 'pending'
    AND p.lease_token = NEW.lease_token AND p.lease_expires_at > unixepoch('now')
    AND d.owner_id = p.owner_id AND d.status = 'draft'
    AND d.manifest_json = json_extract(p.plan_json, '$.manifestJson')
    AND r.approved_by = p.owner_id AND r.policy = 'gizmagick-local-admin-v1' AND r.scope = 'administrator-attested'
    AND r.job_id = json_extract(p.plan_json, '$.review.jobId')
    AND r.snapshot_sha256 = json_extract(p.plan_json, '$.review.snapshotSha256')
    AND j.snapshot_sha256 = r.snapshot_sha256
    AND j.snapshot_json = json_extract(p.plan_json, '$.snapshotJson')
    AND r.manifest_sha256 = json_extract(p.plan_json, '$.review.manifestSha256')
    AND r.report_sha256 = json_extract(p.plan_json, '$.review.reportSha256')
    AND r.report_json = json_extract(p.plan_json, '$.reportJson')
    AND r.candidate_json = json_extract(p.plan_json, '$.candidateJson')
    AND NOT EXISTS (SELECT 1 FROM library_tracks WHERE id = p.track_id)
    AND NOT EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = p.track_id)
    AND (SELECT COUNT(*) FROM admin_publication_objects WHERE publication_id = p.id) = json_array_length(p.plan_json, '$.objects')
    AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = p.draft_id) = json_array_length(p.plan_json, '$.sources')
    AND NOT EXISTS (SELECT 1 FROM json_each(p.plan_json, '$.sources') s WHERE NOT EXISTS (
      SELECT 1 FROM admin_draft_assets a WHERE a.draft_id = p.draft_id AND a.state = 'uploaded'
        AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
        AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256')))
)
BEGIN SELECT RAISE(ABORT, 'Publication changed before commit'); END;

CREATE TRIGGER admin_publication_commit_apply AFTER INSERT ON admin_publication_commits
BEGIN
  INSERT INTO library_tracks (id, owner_id)
    SELECT track_id, owner_id FROM admin_publications WHERE id = NEW.publication_id;
  INSERT INTO library_track_versions (track_id, version_id, status, manifest_key, manifest_sha256,
    schema_version, title, slug, first_section, simple, test)
    SELECT track_id, version_id, 'published', json_extract(plan_json, '$.objects[#-1].key'),
      json_extract(plan_json, '$.objects[#-1].sha256'), 2,
      json_extract(plan_json, '$.candidate.track.title'), json_extract(plan_json, '$.candidate.track.slug'),
      json_extract(plan_json, '$.candidate.track.firstSection'), json_extract(plan_json, '$.candidate.track.simple'),
      COALESCE(json_extract(plan_json, '$.candidate.track.test'), 0)
    FROM admin_publications WHERE id = NEW.publication_id;
  UPDATE library_tracks SET visibility = 'public', status = 'published',
    current_version_id = (SELECT version_id FROM admin_publications WHERE id = NEW.publication_id),
    updated_at = NEW.published_at
    WHERE id = (SELECT track_id FROM admin_publications WHERE id = NEW.publication_id);
  UPDATE admin_publications SET state = 'published', lease_token = NULL, lease_expires_at = 0
    WHERE id = NEW.publication_id;
END;
