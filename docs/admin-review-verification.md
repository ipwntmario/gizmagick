# Phase 7H: bounded administrator approval rechecks

This records the local Phase 7H checkpoint. The [Phase 7L private-only rollout](admin-cloud-batched-rollout.md)
now applies migrations 0005–0009 and enables private batched rechecks on Cloudflare.
The existing legacy review is retained; no new cloud attestation was made.

Implemented and tested locally. **No remote migration or Worker deployment was
performed.** The new `GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED` flag remains
`"false"` in project configuration, as does publishing. Migration
`0006_gizmagick_review_verification_batches.sql` must be reviewed/applied before
enabling this workflow. Existing single-request review needs neither this flag
nor migration 0006, and remains compatible and unchanged.

## What this adds

An administrator can recheck the private files of an exact locally validated
package/report in batches of at most **16** files, save progress, and separately
record a human attestation. Package-preparation receipts from Phase 7G cannot be
reused as approval rechecks. Selecting a report, starting a pass or completing
its last batch never records approval or publishes anything.

The default isolated preview enables this workflow using temporary storage and
synthetic Access credentials. From `frontend`, run
`node scripts/gizmagick-admin-preview.mjs`; never expose it through a tunnel.

1. Upload a private draft and prepare its exact review package, using the
   [batched package workflow](admin-review-packages.md) if desired.
2. Personally run the pinned local validator on the package and exact audio.
   Choose the successful report in the admin page and inspect its measurements.
3. Check the personal-run statement, then **Start or resume approval rechecks**.
   This validates/pins the report and metadata but performs no R2 reads. The
   personal-run checkbox is cleared so final confirmation must be fresh.
4. Click **Recheck next private batch** for each batch. These are private HEAD
   checks, not audio decoding or approval. Testing Time's 129-file structure takes
   nine requests; the 256-file intake limit takes sixteen.
5. After every batch, confirm the personal-run statement again and check the
   distinct batch-window statement. Then click **Record batched administrator
   attestation (keep private)**. Finalization is a separate action with no R2
   reads and one guarded audit insertion.

After reopening, **Refresh recheck status (read only)** retrieves saved progress
without replaying writes. Reselect the exact local report and confirm again
before finalizing. Failed/mismatched responses clear cached authority; a lost
final response can be recovered by reading the recorded result rather than
automatically approving again. Explicit restart discards only an unapproved
pass's checks, requires its exact current ID and confirmation, and deletes no
audio or attestations.

Every check must be at most **five minutes old** at finalization. Attempts expire
after **15 minutes**, or the package expires, whichever comes first. An explicit
start replaces expired/stale passes; there is no automatic renewal. A changed
package requires its exact new local-validator report. Changes to native/custom
SHA-256, file size or the package's ETag reject the affected batch.

## Explicit trust boundary

This remains `administrator-attested`, **not server-decoded**. Unsigned reports
prove no decoder provenance without the administrator's personal assertion.
The audit records the exact report/package fingerprints, approver, verification
ID, storage-check interval and `storage_check_scope: "bounded-batches"`.

These are checks at separate points in time, **not an atomic all-file R2
snapshot**. Earlier objects are not rechecked at final confirmation. Normal
Gizmagick uploads never overwrite allocated private files, and every write
revalidates current D1 identity/metadata/allocations. Nevertheless, an external
privileged storage change after an earlier batch is not ruled out by its receipt.
The five-minute window limits age; it does not eliminate that limitation. The
admin page requires explicit acceptance and displays this distinction after
approval. It must not be silently presented as the older single-request recheck.

The current preflight/publisher **reject this review type**, including one-file
tracks. The admin publishing controls also stay locked for it. Supporting
batched-review publication requires independent, bounded copy/final verification
and an explicitly supported trust policy in the next increment. Raising the
publisher's 16-file cap alone is not sufficient. No public object or library row
is written by this workflow, and its responses always retain `publishing: false`,
`publicationAuthorized: false`, `serverDecoded: false` and `audioProbed: false`.

## API and storage safeguards

Owner-scoped routes below `/api/admin/drafts/:id` use the existing signed Access,
administrator and same-origin guard. POSTs additionally require the admin request
header. Responses are private/no-store with no public CORS allowance.

- `GET`/`HEAD /review-verification`: status or the exact historical attestation;
  no R2 reads or writes.
- `POST /review-verification`: `{report, policy, provenanceConfirmed: true}`
  starts/resumes an exact report. An optional `restartVerificationId` targets
  an explicit replacement. The report wrapper is bounded to 262144 + 2048 bytes.
- `POST /review-verification-batch`: `{verificationId, offset}` rechecks only
  the next 16 files. Duplicate recorded offsets acknowledge existing progress.
- `POST /attest-review-batched`: `{verificationId, policy,
  provenanceConfirmed: true, batchWindowConfirmed: true}` records the separate
  final attestation. Batch/final input is bounded to 2 KiB. Query parameters,
  unknown trust fields, invalid IDs and unsupported methods are rejected.

One verification and at most sixteen receipts per draft bound preparation state.
Report checks reconstruct and validate the measured candidate from the server's
canonical package on every pending operation. Atomic receipt insertion rechecks
the exact package, owner, active status, allocations, verification identity,
expiry and offset. Final insertion repeats these predicates and validates recent
complete batch evidence through a database trigger. Approved batched audits,
verification identities/reports and their checks cannot be updated or deleted.
Same-result retries converge; an already recorded final retry merely acknowledges
history, even after archival/expiry, and makes no new current-storage claim.

## Verification and next steps

All **419 tests**, frontend/Worker lint and Git whitespace checks pass. The normal
player build remains `index-FinxNOWL.css` (250.25 kB) and `index-CQBPIrW7.js`
(387.48 kB). No browser artifacts, secrets or the administrator's unrelated
`.gitignore` edit are included in this checkpoint.

Automated coverage includes real 129-file graph/paths with identification-only
fixture bytes (not Testing Time decoder evidence), 256-file bounded passes,
separate preparation versus recheck receipts, exact report and identity binding,
fresh confirmation, stale/future/expired checks, missing/changed files, concurrent
requests, in-flight/final-write races, immutable audit retention, reload/reply-loss
recovery, malformed responses and publishing denial. Actual Vite- and
Wrangler-bundled Worker tests use temporary D1/R2 and real Lena's Home audio with
measurements from the real pinned local decoder. Browser-like script tests cover
the controls; no actual browser download/cloud sign-in walkthrough is claimed.

Phase 7I now implements [bounded intent preparation/reservation](admin-publication-intents.md)
locally, independently rechecking the historical audit and selected storage.
Its version-2 plan preserves this scope; public copying and catalog commits are
still blocked. The original preflight/publisher continue rejecting this review type.
Next: implement independent conditional copies and fresh bounded final verification
for the new intent workflow, without treating old batch receipts as permission to publish.
Review rollout of migrations 0005/0006 separately; do not enable publishing as
part of that deployment. Original-library identity mapping/import, user uploads,
cleanup, deployed multi-client room checks and live frontend cutover remain
separate work. Keep the known BleepBloop UglyOnPurpose timing issue visible.
