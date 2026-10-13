-- Independent, recent private/public checks. No objects or catalog rows are
-- created by applying this migration. Legacy single-request commits stay valid.
CREATE TABLE admin_publication_final_passes (
  publication_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_publications(id),
  id TEXT UNIQUE NOT NULL CHECK (length(id) = 36),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  owner_id TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  receipts_json TEXT NOT NULL CHECK (json_valid(receipts_json)),
  receipts_sha256 TEXT NOT NULL CHECK (length(receipts_sha256) = 64),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);
CREATE TABLE admin_publication_final_batches (
  pass_id TEXT NOT NULL REFERENCES admin_publication_final_passes(id),
  offset INTEGER NOT NULL CHECK (offset >= 0 AND offset % 16 = 0 AND offset <= 256),
  end_offset INTEGER NOT NULL CHECK (end_offset > offset AND end_offset <= offset + 16 AND end_offset <= 257),
  checked_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  finished_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  PRIMARY KEY (pass_id, offset)
);
ALTER TABLE admin_publication_commits ADD COLUMN final_pass_id TEXT REFERENCES admin_publication_final_passes(id);
ALTER TABLE admin_publication_commits ADD COLUMN storage_check_scope TEXT NOT NULL DEFAULT 'single-request' CHECK (storage_check_scope IN ('single-request', 'bounded-batches'));
ALTER TABLE admin_publication_commits ADD COLUMN storage_checked_from INTEGER;
ALTER TABLE admin_publication_commits ADD COLUMN storage_checked_until INTEGER;

CREATE TRIGGER admin_final_replace BEFORE UPDATE OF id ON admin_publication_final_passes WHEN OLD.id != NEW.id
BEGIN DELETE FROM admin_publication_final_batches WHERE pass_id = OLD.id; END;
CREATE TRIGGER admin_final_retained_update BEFORE UPDATE ON admin_publication_final_passes
WHEN EXISTS (SELECT 1 FROM admin_publication_commits WHERE publication_id = OLD.publication_id)
BEGIN SELECT RAISE(ABORT, 'published final evidence retained'); END;
CREATE TRIGGER admin_final_retained_delete BEFORE DELETE ON admin_publication_final_passes
WHEN EXISTS (SELECT 1 FROM admin_publication_commits WHERE publication_id = OLD.publication_id)
BEGIN SELECT RAISE(ABORT, 'published final evidence retained'); END;
CREATE TRIGGER admin_final_batch_retained_update BEFORE UPDATE ON admin_publication_final_batches
WHEN EXISTS (SELECT 1 FROM admin_publication_commits WHERE final_pass_id = OLD.pass_id)
BEGIN SELECT RAISE(ABORT, 'published final checks retained'); END;
CREATE TRIGGER admin_final_batch_retained_delete BEFORE DELETE ON admin_publication_final_batches
WHEN EXISTS (SELECT 1 FROM admin_publication_commits WHERE final_pass_id = OLD.pass_id)
BEGIN SELECT RAISE(ABORT, 'published final checks retained'); END;

DROP TRIGGER admin_bounded_commit_pending;
CREATE TRIGGER admin_bounded_final_commit_guard BEFORE INSERT ON admin_publication_commits
WHEN (SELECT json_extract(plan_json, '$.planVersion') FROM admin_publications WHERE id = NEW.publication_id) = 2
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM admin_publications p JOIN admin_publication_final_passes f ON f.publication_id = p.id
    JOIN admin_draft_reviews r ON r.draft_id = p.draft_id
    WHERE p.id = NEW.publication_id AND p.state = 'pending' AND p.lease_token = NEW.lease_token AND p.lease_expires_at > unixepoch('now')
      AND f.id = NEW.final_pass_id AND f.owner_id = p.owner_id AND f.plan_sha256 = p.plan_sha256 AND f.expires_at > unixepoch('now')
      AND NEW.storage_check_scope = 'bounded-batches'
      AND r.storage_check_scope = json_extract(p.plan_json, '$.review.storageCheckScope')
      AND r.storage_verification_id IS json_extract(p.plan_json, '$.review.storageAudit.verificationId')
      AND r.storage_checked_from IS json_extract(p.plan_json, '$.review.storageAudit.checkedFrom')
      AND r.storage_checked_until IS json_extract(p.plan_json, '$.review.storageAudit.checkedUntil')
      AND json_array_length(f.receipts_json) = json_array_length(p.plan_json, '$.objects')
      AND NOT EXISTS (SELECT 1 FROM json_each(f.receipts_json) s WHERE NOT EXISTS (
        SELECT 1 FROM admin_publication_objects o WHERE o.publication_id = p.id
          AND o.ordinal = CAST(s.key AS INTEGER) AND o.ordinal = json_extract(s.value, '$.ordinal') AND o.etag = json_extract(s.value, '$.etag')))
      AND (SELECT COUNT(*) FROM admin_publication_final_batches b WHERE b.pass_id = f.id) = (json_array_length(p.plan_json, '$.objects') + 15) / 16
      AND (SELECT MAX(end_offset) FROM admin_publication_final_batches b WHERE b.pass_id = f.id) = json_array_length(p.plan_json, '$.objects')
      AND NEW.storage_checked_from = (SELECT MIN(checked_at) FROM admin_publication_final_batches b WHERE b.pass_id = f.id)
      AND NEW.storage_checked_until = (SELECT MAX(finished_at) FROM admin_publication_final_batches b WHERE b.pass_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM admin_publication_final_batches b WHERE b.pass_id = f.id
        AND (b.checked_at < unixepoch('now') - 300 OR b.checked_at > unixepoch('now') OR b.finished_at < b.checked_at OR b.finished_at > unixepoch('now')
          OR b.offset >= json_array_length(p.plan_json, '$.objects')
          OR b.end_offset != MIN(b.offset + 16, json_array_length(p.plan_json, '$.objects'))))
  ) THEN RAISE(ABORT, 'Bounded final verification changed before commit') END;
END;
