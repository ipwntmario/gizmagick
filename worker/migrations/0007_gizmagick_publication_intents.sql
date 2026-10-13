-- Bounded readiness and immutable v2 intents only. No public copy/commit path.
CREATE TABLE admin_publication_intent_preparations (
  draft_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_drafts(id),
  id TEXT UNIQUE NOT NULL CHECK (length(id) = 36),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  allocation_sha256 TEXT NOT NULL CHECK (length(allocation_sha256) = 64),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);
CREATE TABLE admin_publication_intent_batches (
  preparation_id TEXT NOT NULL REFERENCES admin_publication_intent_preparations(id),
  offset INTEGER NOT NULL CHECK (offset >= 0 AND offset % 16 = 0 AND offset <= 256),
  end_offset INTEGER NOT NULL CHECK (end_offset > offset AND end_offset <= offset + 16 AND end_offset <= 257),
  checked_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  PRIMARY KEY (preparation_id, offset)
);
CREATE TRIGGER admin_intent_preparation_replace BEFORE UPDATE OF id ON admin_publication_intent_preparations
WHEN OLD.id != NEW.id
BEGIN DELETE FROM admin_publication_intent_batches WHERE preparation_id = OLD.id; END;
CREATE TRIGGER admin_intent_preparation_retained_update BEFORE UPDATE ON admin_publication_intent_preparations
WHEN EXISTS (SELECT 1 FROM admin_publications WHERE id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'reserved intent preparation retained'); END;
CREATE TRIGGER admin_intent_preparation_retained_delete BEFORE DELETE ON admin_publication_intent_preparations
WHEN EXISTS (SELECT 1 FROM admin_publications WHERE id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'reserved intent preparation retained'); END;
CREATE TRIGGER admin_intent_batch_retained_update BEFORE UPDATE ON admin_publication_intent_batches
WHEN EXISTS (SELECT 1 FROM admin_publications WHERE id = OLD.preparation_id)
BEGIN SELECT RAISE(ABORT, 'reserved intent checks retained'); END;
CREATE TRIGGER admin_intent_batch_retained_delete BEFORE DELETE ON admin_publication_intent_batches
WHEN EXISTS (SELECT 1 FROM admin_publications WHERE id = OLD.preparation_id)
BEGIN SELECT RAISE(ABORT, 'reserved intent checks retained'); END;

CREATE TRIGGER admin_bounded_intent_guard BEFORE INSERT ON admin_publications
WHEN json_extract(NEW.plan_json, '$.planVersion') = 2
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM admin_publication_intent_preparations s
    WHERE s.id = NEW.id AND s.draft_id = NEW.draft_id AND s.owner_id = NEW.owner_id AND s.request_id = NEW.request_id
      AND s.plan_json = NEW.plan_json AND s.plan_sha256 = NEW.plan_sha256 AND s.expires_at > unixepoch('now')
      AND (SELECT COUNT(*) FROM admin_publication_intent_batches b WHERE b.preparation_id = s.id)
        = (json_array_length(s.plan_json, '$.objects') + 15) / 16
      AND (SELECT MAX(end_offset) FROM admin_publication_intent_batches b WHERE b.preparation_id = s.id)
        = json_array_length(s.plan_json, '$.objects')
      AND NOT EXISTS (SELECT 1 FROM admin_publication_intent_batches b WHERE b.preparation_id = s.id
        AND (b.checked_at < unixepoch('now') - 300 OR b.checked_at > unixepoch('now')
          OR b.offset >= json_array_length(s.plan_json, '$.objects')
          OR b.end_offset != MIN(b.offset + 16, json_array_length(s.plan_json, '$.objects'))))
  ) THEN RAISE(ABORT, 'bounded intent requires exact recent preparation') END;
END;
-- Defence in depth: neither the old publisher nor raw use of its commit table
-- can publish a v2 intent before independent bounded copy/final checks exist.
CREATE TRIGGER admin_bounded_copy_pending BEFORE INSERT ON admin_publication_objects
WHEN (SELECT json_extract(plan_json, '$.planVersion') FROM admin_publications WHERE id = NEW.publication_id) = 2
BEGIN SELECT RAISE(ABORT, 'bounded public copying not implemented'); END;
CREATE TRIGGER admin_bounded_commit_pending BEFORE INSERT ON admin_publication_commits
WHEN (SELECT json_extract(plan_json, '$.planVersion') FROM admin_publications WHERE id = NEW.publication_id) = 2
BEGIN SELECT RAISE(ABORT, 'bounded final verification not implemented'); END;
