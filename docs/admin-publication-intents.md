# Phase 7I: bounded readiness and publication intents

This document records the Phase 7I preparation checkpoint. Phase 7J now adds
[separately confirmed one-object copying](admin-bounded-copy.md), locally only,
behind an additional disabled flag and migration 0008. Final catalog publication
remains blocked. Reservation itself still copies nothing.

Implemented and tested locally. **This is not a complete large-track publisher.**
No remote migration or Worker deployment occurred. The new
`GIZMAGICK_PUBLICATION_INTENTS_ENABLED` flag remains `"false"` in project
configuration, and `GIZMAGICK_PUBLICATION_ENABLED` remains `"false"` too.
Migrations 0006 and `0007_gizmagick_publication_intents.sql` must be applied before
enabling this feature. Existing version-1 publishing remains unchanged.

## What works now

The administrator can prepare an exact reviewed plan, manually check up to 16
private audio sources and 16 proposed public destinations per request, recover
progress after reload, and separately reserve one immutable version-2 publication
intent. The workflow supports both legacy single-request attestations and the
explicit separate-batch audit introduced in Phase 7H, without relabeling either
as server-decoded. It supports up to 256 audio assets plus one manifest, subject
to the existing intake quotas and a 1 MiB publication-plan limit.

**There is no public-copy or catalog-commit action for these intents yet.** No R2
PUT or audio GET is performed. An intent reserves a new track/version identity
in D1; it is not a published track, approval of current global storage state or
permission to publish from earlier receipts. It cannot be replaced/deleted by
archiving, and may become impossible to continue if a conflicting public object
appears later. Cleanup/rollback remain separate, explicitly authorized work.

## Isolated local walkthrough

From `frontend`, `node scripts/gizmagick-admin-preview.mjs --publication` enables
this panel in the temporary local simulator, alongside the legacy publisher.
This uses synthetic Access identity and disposable local D1/R2, not Cloudflare
credentials or Internet-public files; never expose it through a tunnel. The
default private-only preview does not enable intent preparation or bind public
storage. The preseeded legacy review is test-harness provenance, not a real human
administrator's attestation.

1. Open an active, fully uploaded, saved and administrator-attested draft.
2. Under **Prepare a bounded publication intent**, explicitly **Refresh intent
   status (read only)**. Opening/reloading never starts or resumes writes.
3. Click **Prepare or resume readiness checks**. This pins the exact manifest,
   report, candidate, storage-review scope, source snapshot and media base, without
   reading R2 or creating a publication intent.
4. Click **Check next readiness batch (no public write)** for every batch. Audio
   sources must match native/custom SHA-256, byte length and reviewed ETag; each
   destination must be absent, including the manifest destination. Testing Time's
   129-file structure plus manifest requires nine batches; 256 files plus manifest
   require seventeen. After reopening, read-only refresh recovers stored progress.
5. After every batch, check the distinct immutable-reservation/batch-window
   statement, then **Reserve immutable intent (no public copies)**. This separate
   action records the exact plan and identity. Continuation stays locked until
   independent bounded copying and final verification exist.

Refresh, reopening, errors and every check clear reservation confirmation. A
lost reservation response is recovered by reading status, not automatically
replaying writes. Restarting requires the exact current preparation ID and a
confirmation; it discards only unreserved readiness checks, never audio, public
objects or immutable intents. Exact requests/batches/reservations retry safely.
An existing legacy publication is shown as such and cannot be replaced here.

Preparations expire after 15 minutes. Every batch must be at most five minutes
old at reservation; future-dated checks are rejected. An explicit prepare call
renews an expired/stale pass, with no automatic renewal. These are application
limits, not service billing caps. Tests bound R2 work to 16 private/16 public
HEADs and at most 80 counted fixture operations per batch, not a Cloudflare quota,
CPU guarantee or cost cap.

## Exact review and write guards

The service reconstructs the measured candidate using the same pinned report
contract and canonical validator, checks persisted snapshot/report/candidate
hashes and current complete D1 allocations, and refuses reserved library
identities. For a Phase 7H audit it also checks the retained verification owner,
report/package/allocation fingerprints, complete historical batch intervals and
their relation to the recorded approval time. Package expiry gates initial
attestation, not a historical approved record. Independent readiness HEADs still
have to match the original reviewed source ETags and fingerprints.

Atomic conditional preparation/batch/intent writes recheck active ownership,
exact raw manifest, review/job/candidate data, storage-check scope/interval,
allocations, preparation identity/expiry, offset and library identity. The
version-2 intent additionally requires complete recent readiness evidence through
a database trigger. Once reserved, its plan, preparation and checks are retained.
Concurrent requests converge on one reservation rather than duplicate identities.

Migration 0007 blocks version-2 copy receipts and catalog commits at the database
level. The legacy publisher rejects a version-2 plan before copying or taking a
step lease, and the UI directs it to the bounded-intent panel. Future migrations
must replace these fences with full independent copy/final guards, not merely
drop them or raise the legacy publisher's 16-file cap. The original version-1
publisher and preflight still reject the Phase 7H review type and retain their
full-file rechecks.

**No atomic all-file or all-destination snapshot is claimed.** Earlier objects
and destinations are not rechecked at reservation. A privileged storage change
or destination collision after an earlier batch is possible. An immutable intent
does not eliminate that risk; future copies must use conditional exact-source
reads, non-overwriting writes and independent final verification. The explicit
confirmation and response flags retain this boundary:
`publicCopyEnabled: false`, `catalogCommitEnabled: false`, `publishing: false`,
`publicationAuthorized: false`, `serverDecoded: false`, `pointInTimeBatches: true`.
Existing public objects remain public when writes are disabled.

## API

Owner-scoped `GET`/`HEAD /api/admin/drafts/:id/publication-intent` reads status
without R2 operations. `POST` accepts only these bounded UTF-8 JSON actions
(2 KiB maximum), using the existing verified Access/admin, origin and admin
request-header guard:

- `prepare`: `requestId`, `expectedSnapshotSha256`, `expectedReportSha256`, and
  optional `restartPreparationId`. A refreshed preparation supplies the stable
  request ID to reuse; a different active request conflicts.
- `check-batch`: `preparationId`, `offset` (0, 16, etc.). Existing offsets
  acknowledge durable progress without repeated HEADs.
- `reserve`: `preparationId`, `publicationConfirmed: true`,
  `batchWindowConfirmed: true`. No public bytes or catalog pointers are written.

Unknown fields, query parameters, malformed IDs, stale checks and unsupported
methods fail closed. Status is private/no-store with no public CORS allowance.
Disabled configuration queries no migration-0007 tables. No client-side token or
persistent authority storage is added.

## Verification and next steps

All **448 tests**, frontend/Worker lint, normal frontend build and Git whitespace
checks pass. Player bundle names/sizes remain `index-FinxNOWL.css` (250.25 kB)
and `index-CQBPIrW7.js` (387.48 kB). Large-track tests use Testing Time's actual
graph/paths and tiny identification fixtures, not its real audio or decoder
evidence. The actual Vite/Wrangler bundles complete reservation using temporary
Miniflare storage and real Lena's Home bytes previously validated by the pinned
local decoder. Scripted browser-like tests cover manual progression, reload,
confirmation clearing, mismatched replies, double-clicks and response loss;
no actual browser/cloud walkthrough is claimed in this checkpoint.

Next: implement one-object conditional copying for version-2 intents, then fresh
bounded public/private final verification and a guarded atomic catalog commit.
Review rollout separately after those safeguards and local tests are complete.
No original-library import, legacy ownership mapping, user uploads/moderation,
cleanup, online-room verification or live-player cutover occurred here. The
known BleepBloop UglyOnPurpose timing failure remains visible.
