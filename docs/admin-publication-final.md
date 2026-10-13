# Phase 7K: bounded final verification and atomic catalog publication

This records the local Phase 7K checkpoint. The [Phase 7L rollout](admin-cloud-batched-rollout.md)
now installs migrations through 0009 and deploys the code, but public intent,
copying and final publication flags remain disabled. Only private review tools
are newly enabled on Cloudflare.

Implemented and tested locally. **Not deployed or enabled on Cloudflare.**
The repository keeps `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` and the
publication/copy/preparation flags false. No remote migration, Worker deployment,
cloud publication, original-library import or live-player change occurred here.
This completes the local bounded new-track publisher, not the overall migration.

## Plain-English rundown

Copying files is not enough to list a track. The administrator now checks the
private originals and public copies again, in small groups. After every group
passes, a separate confirmation can add the exact approved track/version to the
catalog. The catalog entry, version, public pointer and publication audit save
together or not at all. A lost response is recovered by reading status, not by
automatically repeating the publication.

Files copied earlier are already publicly downloadable by URL. This step does
not upload, overwrite or delete anything. Archiving does not unpublish a track
or remove those files; cleanup and rollback require separate authorization.

## Explicit local workflow

From `frontend`, `node scripts/gizmagick-admin-preview.mjs --publication` enables
the complete workflow in disposable, loopback-only D1/R2 with synthetic identity.
It uses no cloud storage or real administrator credentials. Never expose this
preview through a tunnel. Default private-only preview remains private-only.

1. Reserve a reviewed version-2 intent and record every conditional public copy
   using the [preparation](admin-publication-intents.md) and
   [copy](admin-bounded-copy.md) panels.
2. Under **Final verification and catalog publication**, explicitly refresh status.
3. Choose **Start or resume final verification**. This pins the immutable plan and
   complete copy-receipt identity, without reading R2 or changing the catalog.
4. Choose **Check next final batch (no catalog change)** for each group. Each
   request checks at most 16 private sources and 16 public objects. The manifest
   is checked after the audio. Reload/refresh reads recorded progress only.
5. Read and select the separate publication/batch-window confirmation, then
   choose **Confirm publication to catalog**. No action resumes automatically.
6. After an interrupted response, refresh final status before deciding what to
   do. A committed track is displayed as published with all continuation locked.

Every check must have started within five minutes of commit, and the pass
expires after 15 minutes. The start time comes from D1 before the batch's first
HEAD; a slow batch cannot make an early inspection appear newer. Receipts also
record completion time. The retained audit encloses the checks from the earliest
batch start through the latest completion. Future/inverted times are rejected.
Restart requires the exact current pass and a UI confirmation; it discards only
uncommitted final checks, not objects, copy receipts, intent or catalog entries.

## Trust boundary

These are **separate recent checks, not an atomic all-file storage snapshot**.
Earlier objects are not rechecked at the final confirmation. Privileged external
storage changes after a batch cannot be ruled out. Normal Gizmagick uploads and
public copies never overwrite objects. The confirmation explicitly accepts this
bounded-window model, and the commit stores `storage_check_scope: bounded-batches`.
There is no transaction spanning D1 and R2.

The original human/local-validator attestation is preserved. Single-request and
separate-batch review scopes are not relabeled, and nothing is marked server-decoded.
Private HEADs must match the original review's native/custom SHA-256, size and
ETag. Public HEADs must additionally match the exact immutable copy receipt,
publication/plan markers, expected content type and cache policy. Copy receipts
and the earlier readiness pass do not substitute for these fresh checks.

The final commit makes no R2 requests. It reconstructs current D1 authority and
uses a two-minute publication lease plus a guarded database transaction. Guards
check active ownership, exact manifest/review/job/report/candidate data and scope,
complete allocations/copy receipts, unoccupied new-track identity, exact final
pass, complete sequential batches, expiry and freshness. A SQL constraint or
failed guard rolls back every catalog/audit/pointer write. Completed final
evidence is retained and cannot be rewritten or deleted through this workflow.

## Configuration and API

Migration `0009_gizmagick_bounded_publication_final.sql` replaces migration 0007's
version-2 commit deny fence with independent final-evidence guards. Migration
0004's original authority/atomic catalog triggers remain. Legacy version-1
commits keep their single-request scope and do not need the new tables/columns
until the migration is applied. The legacy publisher still rejects version-2
plans; it cannot bypass this workflow.

Finalization requires all effective preparation/preflight/publication/copy flags
plus `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED: true`, and migrations through
0009. A missing final-commit guard fails before publication. Disabled finalization
queries no migration-0009 tables. Configuration remains disabled in this branch.

Owner-scoped `GET`/`HEAD /api/admin/drafts/:id/publication-final` reads status with
no R2 operations. JSON POST (2 KiB maximum) accepts only:

- `start`: `publicationId`, `expectedPlanSha256`, UUID `requestId`, optional
  `restartPassId`. A refreshed pass supplies the stable request ID to reuse.
- `check-batch`: `publicationId`, `expectedPlanSha256`, `passId`, `offset`
  (0, 16, etc.). Exact completed offsets acknowledge history without another
  inspection or renewing timestamps.
- `commit`: `publicationId`, `expectedPlanSha256`, `passId`,
  `publicationConfirmed: true`, `batchWindowConfirmed: true`.

Existing verified Access/admin, ownership, origin and request-header guards apply.
Unknown fields/query parameters, stale identities and unsupported methods fail
closed. Status is private/no-store, has no public CORS allowance and grants no
publication authority. Its effective catalog capability is distinct from the
copy-only status returned by `/publication-intent`. The copy panel now also
reports a completed publication correctly, including when finalization is disabled.
An exact commit retry acknowledges the retained publication even after expiry
or archival; it performs no new checks or writes. It cannot create another entry.

## Verification and next steps

All **530 tests**, frontend/Worker lint, normal build and Git whitespace checks
pass. Testing Time's actual 129-file graph and 256-file contract fixtures finish
bounded checks and guarded commits; these tiny fixtures are not decoder evidence.
Actual Vite/Wrangler bundles complete the workflow using real Lena's Home bytes,
previously checked by the local decoder, in temporary Miniflare storage. Tests
cover stale/future windows, source/public changes, receipt/lease/review/pass races,
transaction rollback, response loss, manual confirmations and locked completion.
Scripted browser-like checks are not an actual signed-in cloud/browser walkthrough.

The normal player remains unchanged: `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB). The existing public cloud test and private drafts
were not changed. The known BleepBloop UglyOnPurpose timing failure remains visible.

Next: review the Cloudflare rollout for migrations 0005–0009 and the disabled
bounded-workflow flags, with private-only verification before any separately
authorized public test. Original-library ownership/legacy mapping and measured
import, two-client pinned-room checks, user-upload/moderation/cleanup workflows,
and the live frontend cutover remain separate work and approval gates.
