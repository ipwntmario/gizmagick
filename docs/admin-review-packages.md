# Phase 7G: resumable batched review packages

This records the local Phase 7G checkpoint. The [Phase 7L private-only rollout](admin-cloud-batched-rollout.md)
now applies migrations 0005–0009 and enables this feature on Cloudflare. Public
writing remains disabled; a fresh cloud private-workflow test is still pending.

Implemented and tested locally; **not deployed or enabled on Cloudflare**.
Migration `0005_gizmagick_review_package_batches.sql` and
`GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = "true"` are required before rollout.
The project configuration deliberately keeps this flag and publishing **false**.
Existing cloud review functionality continues without migration 0005 when the
new flag is absent/false. No music, cloud objects or catalog entries were changed.

## Local administrator workflow

The isolated preview enables this feature using temporary D1/R2 and synthetic
Access credentials. From `frontend`, run:

```powershell
node scripts/gizmagick-admin-preview.mjs
```

This is not a real sign-in or cloud deployment; never expose it through a tunnel.
Create a new private draft, upload all referenced files, and save metadata first.

1. Under **Local administrator review**, click **Start or resume package
   preparation**. This reserves/reuses one preparation; it checks no R2 files.
2. Click **Check next package batch** for each batch. Each request inspects at
   most 16 private objects and records a server-side batch result. Testing Time's
   129-file structure requires nine batch requests; 256 files require sixteen.
3. After a reload/reopen, click **Refresh preparation status (read only)** to
   recover recorded progress. No batches run automatically, and failures lock
   continuation until an explicit refresh/start. Lost-response retries are safe.
4. After every batch is recorded, click **Finish and download review package**.
   Finishing is separate from the last batch, reads no audio objects, and creates
   the same version-1 package consumed by the existing local validator. Delivery
   uses the browser's normal download flow; repeat this action if needed.
5. Personally run the pinned local validator on that exact package and private
   audio, inspect its successful report, then explicitly confirm provenance and
   record the administrator attestation as described in [the review guide](admin-review.md).

Restarting requires a confirmation and the exact current preparation ID. It
discards preparation checks and its completed, still-unattested review package,
invalidating reports for that package. Audio and attestations are never deleted.
Expired or metadata/allocation-changed preparations are replaced only on an
explicit start. Expiry is 24 hours from start, not 24 hours from finish. Attested
or archived drafts cannot start, restart, advance or finish preparation.

The older single-request package button/API remain compatible. Do not mix its
packages/reports with a different preparation: only the exact current review job
can be attested. The read-only inspector from Phase 7F remains diagnostic and
its client-supplied results cannot become package receipts.

## Trust and persistence

These are private preparation writes, **not** an approval or publishing workflow.
The same verified Access/admin, owner, origin and request-header guards apply.
Status is non-cacheable with no public CORS allowance. Gizmagick adds no browser
token storage or persisted client-side preparation authority, validates draft/manifest/package
identity and progress, and never automatically loops, retries, approves or
publishes. Completed-package checksums and loaded upload fingerprints are checked
before initiating its download.

Owner-scoped routes under `/api/admin/drafts/:id` are:

- `GET`/`HEAD /review-package-batches`: status only; no R2 reads or writes.
- `POST /review-package-batches`: `{}` starts/resumes; `{ "restartJobId": "..." }`
  replaces only that exact preparation. Expired/stale starts renew it explicitly.
- `POST /review-package-batch`: `{ "jobId": "...", "offset": 0 }` records the next
  batch (offsets 0, 16, etc.). Old recorded offsets return durable progress.
- `POST /review-package-finish`: `{ "jobId": "..." }` returns a wrapper containing
  the completed canonical `package` and preparation status after separate finalization.

POST input is bounded to 2 KiB of UTF-8 JSON. Unknown fields, query parameters,
invalid identities, out-of-order offsets and unsupported methods are rejected.
Clients cannot supply snapshots, file checks or approval fields. The legacy
package/report limits and local validator's format are unchanged.

The new migration permits one preparation per draft and at most sixteen batches.
Atomic conditional batch insertion rechecks ownership, active status, exact
metadata, complete allocations, preparation identity/expiry and next offset.
Concurrent same-batch requests converge on one result. A conditional restart
replaces the preparation ID and clears its old batches/completed pending package.
Finalization requires contiguous complete batches, exact recorded asset identity
and fingerprints, unchanged allocations, active ownership and no attestation.
It records a bounded canonical package in the existing `admin_draft_review_jobs`;
same-package finish retries do not duplicate or extend it.

Each batch checks native/custom SHA-256, byte length and ETag. Earlier R2 objects
are **not** rechecked by subsequent batches or finalization. This is not one
atomic storage snapshot, proof of decoding or whole-track approval. Responses
explicitly retain `audioProbed: false`, `publishing: false` and
`publicationAuthorized: false`. The original attestation endpoint still rechecks
**all** private objects against the completed package and reconstructs/validates
the measured candidate before its guarded immutable audit insertion. Changed
objects cannot gain approval merely by completing or retrying preparation.

## Verification and next steps

All **384 tests**, frontend/Worker lint and Git whitespace checks pass. The normal
player build is unchanged: `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB). No browser artifacts or the administrator's
unrelated `.gitignore` edit are included in this checkpoint.

Local automated coverage includes 129/256-file bounded preparation, durable
resumption, idempotent batches/finish, concurrent requests, replacement/expiry,
malformed inputs, owner/admin/Access/origin/method gates, missing objects,
sanitized failures, stale allocation/metadata/archive/restart races, final-write
fencing, corrupted receipts, manual client progression, rejected replies,
download validation and unchanged approval/publication boundaries. Large-graph
tests use tiny Ogg identification fixtures, **not** Testing Time decoder evidence.
The real Vite- and Wrangler-bundled Worker packages actual Lena's Home audio in
temporary Miniflare storage, and its package passes the real local CLI and
existing administrator-attestation/publisher pipeline. Scripted browser-like
tests verify controls; no real-browser download or cloud walkthrough is claimed.

Phase 7H now adds a separate [bounded approval-recheck workflow](admin-review-verification.md)
locally, with explicit recent-batch audit scope and its own disabled rollout flag.
It is not an atomic storage snapshot and the current publisher rejects that
new review type. The legacy approval/preflight paths still inspect all files per
request. Next: large-track publication intent/copy/final verification; the publisher
still refuses more than **16 audio assets**, regardless
of a finished package or administrator attestation. No public-library import,
live-player cutover, user-upload moderation or cleanup is included. Review and
apply migration 0005 before a separately verified cloud rollout; do not enable
publishing as part of that rollout.
