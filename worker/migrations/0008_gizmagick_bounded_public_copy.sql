-- Copy receipts only. The 0007 catalog-commit deny fence remains in place.
ALTER TABLE admin_publication_objects ADD COLUMN lease_token TEXT;
DROP TRIGGER admin_bounded_copy_pending;
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
      AND NOT EXISTS (SELECT 1 FROM library_tracks WHERE id = p.track_id)
      AND NOT EXISTS (SELECT 1 FROM library_track_versions WHERE track_id = p.track_id)
      AND NEW.ordinal = (SELECT COUNT(*) FROM admin_publication_objects WHERE publication_id = p.id)
      AND NEW.ordinal < json_array_length(p.plan_json, '$.objects')
      AND (SELECT COUNT(*) FROM admin_draft_assets WHERE draft_id = p.draft_id) = json_array_length(p.plan_json, '$.sources')
      AND NOT EXISTS (SELECT 1 FROM json_each(p.plan_json, '$.sources') s WHERE NOT EXISTS (
        SELECT 1 FROM admin_draft_assets a WHERE a.draft_id = p.draft_id AND a.state = 'uploaded'
          AND a.asset_id = json_extract(s.value, '$.assetId') AND a.object_key = json_extract(s.value, '$.objectKey')
          AND a.byte_length = json_extract(s.value, '$.byteLength') AND a.sha256 = json_extract(s.value, '$.sha256')))
  )
BEGIN SELECT RAISE(ABORT, 'Bounded copy changed before receipt'); END;
