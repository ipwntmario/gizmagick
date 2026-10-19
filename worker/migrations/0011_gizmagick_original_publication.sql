-- Initial publication of a reserved original only, never a published revision.
-- Applying this migration copies no objects and publishes no tracks.
CREATE VIEW admin_original_publication_identity AS
SELECT i.* FROM admin_original_imports i
JOIN library_tracks t ON t.id = i.track_id JOIN admin_drafts d ON d.id = i.draft_id
WHERE t.legacy_key = i.legacy_key AND t.owner_id = i.owner_id
  AND t.visibility = 'private' AND t.status = 'draft' AND t.current_version_id IS NULL
  AND d.owner_id = i.owner_id AND d.status = 'draft' AND d.original_legacy_key = i.legacy_key
  AND json_extract(d.manifest_json, '$.track.id') = i.track_id
  AND json_extract(d.manifest_json, '$.versionId') != i.source_version_id
  AND NOT EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = i.track_id);

-- One identity predicate shared by receipt and commit fences. New tracks still
-- require an unused identity; originals require the exact private reservation.
CREATE VIEW admin_publication_identity_authority AS
SELECT p.id AS publication_id FROM admin_publications p JOIN admin_drafts d ON d.id = p.draft_id
WHERE d.original_legacy_key IS NULL AND json_type(p.plan_json, '$.originalImport') IS NULL
  AND (json_extract(p.plan_json, '$.planVersion') = 1
    OR (json_extract(p.plan_json, '$.planVersion') = 2 AND json_extract(p.plan_json, '$.workflow') = 'bounded-new-track'))
  AND NOT EXISTS (SELECT 1 FROM library_tracks WHERE id = p.track_id)
  AND NOT EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = p.track_id)
UNION ALL
SELECT p.id FROM admin_publications p JOIN admin_original_publication_identity i ON i.draft_id = p.draft_id
WHERE json_extract(p.plan_json, '$.planVersion') = 2 AND json_extract(p.plan_json, '$.workflow') = 'bounded-original-track'
  AND i.track_id = p.track_id AND i.owner_id = p.owner_id
  AND i.legacy_key = json_extract(p.plan_json, '$.originalImport.legacyKey')
  AND i.source_version_id = json_extract(p.plan_json, '$.originalImport.sourceVersionId')
  AND i.source_manifest_sha256 = json_extract(p.plan_json, '$.originalImport.sourceManifestSha256');

CREATE TRIGGER admin_original_publication_guard AFTER INSERT ON admin_publications
WHEN NOT EXISTS (SELECT 1 FROM admin_publication_identity_authority WHERE publication_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Publication identity or original mapping changed'); END;

-- Preserve all 0008 receipt checks; only the identity predicate is generalized.
DROP TRIGGER admin_bounded_copy_guard;
CREATE TRIGGER admin_bounded_copy_guard BEFORE INSERT ON admin_publication_objects
WHEN (SELECT json_extract(plan_json, '$.planVersion') FROM admin_publications WHERE id = NEW.publication_id) = 2
  AND NOT EXISTS (
    SELECT 1 FROM admin_publications p JOIN admin_drafts d ON d.id = p.draft_id
    JOIN admin_draft_reviews r ON r.draft_id = p.draft_id
    JOIN admin_draft_review_jobs j ON j.id = r.job_id AND j.draft_id = p.draft_id
    WHERE p.id = NEW.publication_id AND p.state = 'pending'
      AND p.lease_token = NEW.lease_token AND p.lease_expires_at > unixepoch('now')
      AND d.owner_id = p.owner_id AND d.status = 'draft'
      AND d.manifest_json = json_extract(p.plan_json, '$.manifestJson')
      AND r.approved_by = p.owner_id AND r.policy = 'gizmagick-local-admin-v1' AND r.scope = 'administrator-attested'
      AND r.job_id = json_extract(p.plan_json, '$.review.jobId')
      AND r.snapshot_sha256 = json_extract(p.plan_json, '$.review.snapshotSha256') AND j.snapshot_sha256 = r.snapshot_sha256
      AND j.snapshot_json = json_extract(p.plan_json, '$.snapshotJson')
      AND r.manifest_sha256 = json_extract(p.plan_json, '$.review.manifestSha256')
      AND r.report_sha256 = json_extract(p.plan_json, '$.review.reportSha256')
      AND r.report_json = json_extract(p.plan_json, '$.reportJson') AND r.candidate_json = json_extract(p.plan_json, '$.candidateJson')
      AND r.storage_check_scope = json_extract(p.plan_json, '$.review.storageCheckScope')
      AND r.storage_verification_id IS json_extract(p.plan_json, '$.review.storageAudit.verificationId')
      AND r.storage_checked_from IS json_extract(p.plan_json, '$.review.storageAudit.checkedFrom')
      AND r.storage_checked_until IS json_extract(p.plan_json, '$.review.storageAudit.checkedUntil')
      AND EXISTS (SELECT 1 FROM admin_publication_identity_authority WHERE publication_id = p.id)
      AND NEW.ordinal = (SELECT COUNT(*) FROM admin_publication_objects WHERE publication_id = p.id)
      AND NEW.ordinal < json_array_length(p.plan_json, '$.objects')
      AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = p.draft_id) = json_array_length(p.plan_json, '$.sources')
      AND NOT EXISTS (SELECT 1 FROM json_each(p.plan_json, '$.sources') s WHERE NOT EXISTS (
        SELECT 1 FROM admin_draft_assets a WHERE a.draft_id = p.draft_id AND a.state = 'uploaded'
          AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
          AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256')))
  )
BEGIN SELECT RAISE(ABORT, 'Bounded copy changed before receipt'); END;

-- Preserve all 0004 commit authority checks. 0009's independent recent final
-- verification fence remains installed unchanged and applies to both v2 paths.
DROP TRIGGER admin_publication_commit_guard;
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
    AND EXISTS (SELECT 1 FROM admin_publication_identity_authority WHERE publication_id = p.id)
    AND (SELECT COUNT(*) FROM admin_publication_objects WHERE publication_id = p.id) = json_array_length(p.plan_json, '$.objects')
    AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = p.draft_id) = json_array_length(p.plan_json, '$.sources')
    AND NOT EXISTS (SELECT 1 FROM json_each(p.plan_json, '$.sources') s WHERE NOT EXISTS (
      SELECT 1 FROM admin_draft_assets a WHERE a.draft_id = p.draft_id AND a.state = 'uploaded'
        AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
        AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256')))
)
BEGIN SELECT RAISE(ABORT, 'Publication changed before commit'); END;

DROP TRIGGER admin_publication_commit_apply;
CREATE TRIGGER admin_publication_commit_apply AFTER INSERT ON admin_publication_commits
BEGIN
  INSERT INTO library_tracks (id, owner_id)
    SELECT track_id, owner_id FROM admin_publications
    WHERE id = NEW.publication_id AND json_type(plan_json, '$.originalImport') IS NULL;
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
    updated_at = NEW.published_at WHERE id = (SELECT track_id FROM admin_publications WHERE id = NEW.publication_id);
  UPDATE admin_publications SET state = 'published', lease_token = NULL, lease_expires_at = 0 WHERE id = NEW.publication_id;
END;
