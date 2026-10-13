# Phase 7J: one-object conditional public copying

This records the Phase 7J copying checkpoint. Phase 7K now adds
[independent final checks and catalog publication](admin-publication-final.md),
locally only, behind migration 0009 and another disabled flag. Copying still
never commits a catalog entry by itself.

Implemented and tested locally, **not deployed or enabled on Cloudflare**.
This is the copying portion of the large-track publisher, not its catalog commit.
The repository keeps `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED`,
`GIZMAGICK_PUBLICATION_INTENTS_ENABLED` and `GIZMAGICK_PUBLICATION_ENABLED`
set to `"false"`. No remote migration, Worker deployment, cloud file copy,
original-library import or player-source change was performed for this checkpoint.

## Plain-English rundown

The previous step saved a fixed plan for an approved track. This step can copy
one file from that plan into public storage per confirmed click. It checks that
the reviewed private file has not changed and refuses to overwrite an existing
destination. If a response disappears after a successful copy, an explicit retry
can recognize that exact copy instead of uploading it again or advancing to the
following file. The manifest is copied after all audio files have copy receipts.

**A copy makes bytes publicly downloadable by URL immediately.** It does not
add the track to the catalog. A later step must freshly verify private/public
objects and separately commit the catalog entry. That step remains blocked in
both the API and database. Archiving or disabling writes cannot remove files
already copied; cleanup and rollback require separate authorization.

## Local workflow and API

`node scripts/gizmagick-admin-preview.mjs --publication` from `frontend` enables
the controls in disposable, loopback-only local D1/R2 with synthetic identity.
It does not use Cloudflare storage or a real administrator's attestation.
Never expose this test harness through a tunnel. The default private-only
preview does not enable or bind the public-copy workflow.

1. Prepare, check and reserve an exact reviewed version-2 intent as described in
   [the preparation workflow](admin-publication-intents.md).
2. Refresh intent status. Neither refresh nor reload resumes any writes.
3. Select the separate public-exposure checkbox, then **Copy one object publicly**.
4. Check the recorded progress and explicitly confirm each following copy.
5. After all copies, stop: final catalog verification/publication is still locked.

The existing owner-scoped `/api/admin/drafts/:id/publication-intent` endpoint
accepts a new JSON POST action (same 2 KiB input limit):

```json
{
  "action": "copy-one",
  "publicationId": "the-exact-intent-uuid",
  "expectedPlanSha256": "the-exact-64-character-plan-checksum",
  "ordinal": 0,
  "publicationConfirmed": true
}
```

`ordinal` is the object's zero-based position in the fixed audio-first,
manifest-last plan. Only the next unrecorded position can copy. A confirmed retry
of an already recorded position acknowledges progress only: it never copies
another object and is not a fresh verification of that earlier public object.

Status GET/HEAD performs no R2 operations. It reports the effective
`publicCopyEnabled` flag and exact recorded progress even after copying is
disabled. `nextAction` is `copy-one-object` only for an active, pending intent
with enabled copying and remaining objects. Catalog-related flags remain false.
The server independently rechecks eligibility on each POST; a status read is
not a permission token. Existing version-1 intents cannot be adopted here, and
the legacy publisher still cannot continue version-2 intents.

## Safeguards and limits

Copying requires the preparation, preflight, publication and separate bounded-copy
flags, distinct private/public buckets, and migrations 0006–0008. Before any
public write, the API checks that migration 0008's guarded copy-receipt trigger
is installed. Enabling only a flag cannot bypass a missing migration.

Every new copy reconstructs the exact administrator-attested plan from current
metadata, allocations, report, candidate and retained review scope. Both
single-request and separate-batch reviews keep their original audit labels;
neither is relabeled as server-decoded. Preparation expiry does not expire an
immutable reserved plan. The current review/identity checks and selected source
checks are independent of the old readiness receipts.

A two-minute **lease** is a temporary database lock that prevents overlapping
copy steps. Current ownership, active status, exact review/allocations and
unoccupied new-track identity are checked under that lease before the public
write and receipt. Migration 0008 rechecks these predicates at receipt insertion,
including the lease token and sequential position. Receipts remain immutable.
The migration replaces the copy deny fence, **not** the final catalog-commit
deny fence from migration 0007. Version-1 copying remains compatible with older
databases and requires no new receipt column until migration 0008 is applied.

For audio, the selected private HEAD must match byte length, native/custom
SHA-256 and reviewed ETag. A conditional GET then reads only that ETag, and its
metadata is checked again. Bytes stream to a non-overwriting conditional PUT,
with the planned SHA-256 supplied for storage-side integrity checking. These
operations follow [Cloudflare's R2 Workers API semantics](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
No whole-audio buffering or new server-side decoder is introduced.

Recovery accepts an existing destination only when its native/custom hash, size,
ETag, publication/plan markers, content type and immutable-cache policy match.
Unrelated objects with identical bytes are not adopted. One copy performs at most
one explicit private HEAD, one conditional private GET, two explicit public HEADs
and one public PUT; manifest/recovery actions use fewer. Database metadata work
is bounded by the existing 256-asset/1 MiB plan limits. These are application
bounds, not a Cloudflare CPU guarantee, pricing cap or quota claim.

There is no atomic transaction spanning D1 and R2. A failure after PUT may leave
public bytes without a receipt, and a privileged change after a check remains
possible. Errors clear cached UI status/confirmation and require read-only
refresh before another decision. No automatic retries, object deletion, overwrite
or catalog promotion occur.

## Verification and next step

All **488 tests** pass, including Testing Time's 129-file graph, 256-file copying,
source/destination races, receipt/lease races, interrupted responses, checksums,
feature gates and manual UI progression. Large graph tests use tiny contract
fixtures, not real decoder evidence. Actual Vite/Wrangler bundles copy real,
locally validated Lena's Home bytes in temporary Miniflare storage, retaining the
separate-batch review label and denying the catalog commit. Browser-like script
tests are not an actual signed-in browser/cloud walkthrough.

Frontend/Worker lint, normal build and Git whitespace checks pass. Player outputs
remain `index-FinxNOWL.css` (250.25 kB) and `index-CQBPIrW7.js` (387.48 kB).

Next: independent fresh bounded private/public final verification and a separately
confirmed, guarded atomic catalog commit. Review the cloud rollout only after
those safeguards pass local tests. Existing cloud test objects remain untouched.
