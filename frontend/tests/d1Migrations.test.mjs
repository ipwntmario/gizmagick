import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';

const names = ['0001_gizmagick_library.sql', '0002_gizmagick_drafts.sql', '0003_gizmagick_draft_reviews.sql',
  '0004_gizmagick_publications.sql', '0005_gizmagick_review_package_batches.sql', '0006_gizmagick_review_verification_batches.sql',
  '0007_gizmagick_publication_intents.sql', '0008_gizmagick_bounded_public_copy.sql', '0009_gizmagick_bounded_publication_final.sql', '0010_gizmagick_original_imports.sql', '0011_gizmagick_original_publication.sql'];

test('versioned D1 migrations compile through the installed delivery splitter with remote-compatible guard bodies', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [index, name] of names.entries()) {
      const sql = await readFile(new URL(`../../worker/migrations/${name}`, import.meta.url), 'utf8');
      // Remote D1 rejected the compound SELECT CASE guard bodies during 7L.
      // Keep the equivalent trigger-WHEN predicates used by the deployed 0004.
      if (index >= 5) assert(!/SELECT\s+CASE\s+WHEN/i.test(sql), name);
      db.exec('BEGIN;');
      for (const statement of unstable_splitSqlQuery(sql)) db.exec(statement);
      db.exec('COMMIT;');
    }
    for (const name of ['admin_batched_review_guard', 'admin_bounded_intent_guard', 'admin_bounded_copy_guard', 'admin_bounded_final_commit_guard', 'admin_original_publication_guard']) {
      assert(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name));
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});
