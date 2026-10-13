-- Recent, owner-scoped storage rechecks of an exact human-review report.
-- Preparation receipts from migration 0005 cannot satisfy this workflow.
CREATE TABLE admin_draft_review_verifications (
  draft_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_drafts(id),
  id TEXT UNIQUE NOT NULL CHECK (length(id) = 36),
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  allocation_sha256 TEXT NOT NULL CHECK (length(allocation_sha256) = 64),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  report_sha256 TEXT NOT NULL CHECK (length(report_sha256) = 64),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);
CREATE TABLE admin_draft_review_verification_batches (
  verification_id TEXT NOT NULL REFERENCES admin_draft_review_verifications(id),
  offset INTEGER NOT NULL CHECK (offset >= 0 AND offset % 16 = 0 AND offset <= 240),
  end_offset INTEGER NOT NULL CHECK (end_offset > offset AND end_offset <= offset + 16 AND end_offset <= 256),
  checked_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  PRIMARY KEY (verification_id, offset)
);
ALTER TABLE admin_draft_reviews ADD COLUMN storage_check_scope TEXT NOT NULL DEFAULT 'single-request'
  CHECK (storage_check_scope IN ('single-request', 'bounded-batches'));
ALTER TABLE admin_draft_reviews ADD COLUMN storage_verification_id TEXT REFERENCES admin_draft_review_verifications(id)
  CHECK ((storage_check_scope = 'single-request' AND storage_verification_id IS NULL)
    OR (storage_check_scope = 'bounded-batches' AND storage_verification_id IS NOT NULL));
ALTER TABLE admin_draft_reviews ADD COLUMN storage_checked_from INTEGER;
ALTER TABLE admin_draft_reviews ADD COLUMN storage_checked_until INTEGER;

CREATE TRIGGER admin_review_verification_replace BEFORE UPDATE OF id ON admin_draft_review_verifications
WHEN OLD.id != NEW.id
BEGIN
  DELETE FROM admin_draft_review_verification_batches WHERE verification_id = OLD.id;
END;
CREATE TRIGGER admin_review_verification_retained_update BEFORE UPDATE ON admin_draft_review_verifications
WHEN EXISTS (SELECT 1 FROM admin_draft_reviews WHERE storage_verification_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'attested verification retained'); END;
CREATE TRIGGER admin_review_verification_retained_delete BEFORE DELETE ON admin_draft_review_verifications
WHEN EXISTS (SELECT 1 FROM admin_draft_reviews WHERE storage_verification_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'attested verification retained'); END;
CREATE TRIGGER admin_review_verification_batch_retained_update BEFORE UPDATE ON admin_draft_review_verification_batches
WHEN EXISTS (SELECT 1 FROM admin_draft_reviews WHERE storage_verification_id = OLD.verification_id)
BEGIN SELECT RAISE(ABORT, 'attested verification checks retained'); END;
CREATE TRIGGER admin_review_verification_batch_retained_delete BEFORE DELETE ON admin_draft_review_verification_batches
WHEN EXISTS (SELECT 1 FROM admin_draft_reviews WHERE storage_verification_id = OLD.verification_id)
BEGIN SELECT RAISE(ABORT, 'attested verification checks retained'); END;

CREATE TRIGGER admin_batched_review_guard BEFORE INSERT ON admin_draft_reviews
WHEN NEW.storage_check_scope = 'bounded-batches'
  AND NOT EXISTS (
    SELECT 1 FROM admin_draft_review_verifications v JOIN admin_draft_review_jobs j ON j.draft_id = v.draft_id AND j.id = v.job_id
    WHERE v.id = NEW.storage_verification_id AND v.draft_id = NEW.draft_id AND v.owner_id = NEW.approved_by
      AND v.job_id = NEW.job_id AND v.snapshot_sha256 = NEW.snapshot_sha256
      AND v.report_sha256 = NEW.report_sha256 AND v.report_json = NEW.report_json
      AND j.snapshot_sha256 = v.snapshot_sha256 AND j.expires_at > unixepoch('now') AND v.expires_at > unixepoch('now')
      AND (SELECT COUNT(*) FROM admin_draft_review_verification_batches b WHERE b.verification_id = v.id)
        = (json_array_length(j.snapshot_json, '$.assets') + 15) / 16
      AND (SELECT MAX(end_offset) FROM admin_draft_review_verification_batches b WHERE b.verification_id = v.id)
        = json_array_length(j.snapshot_json, '$.assets')
      AND NEW.storage_checked_from = (SELECT MIN(checked_at) FROM admin_draft_review_verification_batches b WHERE b.verification_id = v.id)
      AND NEW.storage_checked_until = (SELECT MAX(checked_at) FROM admin_draft_review_verification_batches b WHERE b.verification_id = v.id)
      AND NEW.storage_checked_from >= unixepoch('now') - 300
      AND NEW.storage_checked_until <= unixepoch('now')
      AND NOT EXISTS (SELECT 1 FROM admin_draft_review_verification_batches b WHERE b.verification_id = v.id
        AND (b.offset >= json_array_length(j.snapshot_json, '$.assets')
          OR b.end_offset != MIN(b.offset + 16, json_array_length(j.snapshot_json, '$.assets'))))
  )
BEGIN SELECT RAISE(ABORT, 'batched review requires recent exact verification'); END;
CREATE TRIGGER admin_batched_review_retained_update BEFORE UPDATE ON admin_draft_reviews
WHEN OLD.storage_check_scope = 'bounded-batches' OR NEW.storage_check_scope = 'bounded-batches'
BEGIN SELECT RAISE(ABORT, 'batched administrator attestation immutable'); END;
CREATE TRIGGER admin_batched_review_retained_delete BEFORE DELETE ON admin_draft_reviews
WHEN OLD.storage_check_scope = 'bounded-batches'
BEGIN SELECT RAISE(ABORT, 'batched administrator attestation retained'); END;
