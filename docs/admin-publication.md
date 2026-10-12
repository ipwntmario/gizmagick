# Phase 7A: read-only publication preflight

Implemented locally and enabled on the existing Cloudflare Worker on October 12,
2026. **Deployment checks passed; signed-in cloud preview verification is pending.**
This is a readiness inspection for administrator-owned, attested new-track
drafts, not a publisher. No public objects, library rows, ownership mappings,
audit records, or playback pointers are written. The live player is unchanged.

## Private API and rollout boundary

`GET /api/admin/drafts/:id/publication-preview` (also HEAD) uses the existing
signed Access JWT, administrator role, owner lookup, same-origin restrictions,
and private/no-store responses. It has no public CORS permissions. POST and other
write methods return 405. There is no new browser button in this increment.
`capabilities.publicationPreflight` describes availability independently of
`publishing`, which remains false.

The version-controlled flag `GIZMAGICK_PUBLICATION_PREFLIGHT_ENABLED = "true"`
enables this read-only inspection. It additionally requires uploads, reviews, D1, and distinct
private/public R2 bindings. A disabled preview returns 503 without querying
review tables. No migration, secret, dependency, or cloud resource is added.
Local automated fixtures explicitly enable it. The local UI preview harness
remains unchanged; it does not enable this API.

## Inspections

The preview requires an active draft and its stored administrator attestation.
It checks the review policy/scope and verified approver, retrieves the exact
historical job, and checks bounded stored documents. It reconstructs the current
private snapshot with native R2 SHA-256, custom checksum, size, and ETag checks,
then compares the historical snapshot, manifest, and report hashes. A changed or
missing private object fails; a report or client-supplied manifest alone is not
enough to proceed.

The stored report is revalidated with the pinned local-review contract. Its
candidate is reconstructed from server-held metadata and measurements, rerun
through the canonical graph/timing validator, and compared to the recorded
candidate. This remains **administrator-attested, not server-decoded**. Package
expiry gates the initial attestation; expiry alone does not erase a historical
review or prevent its inspection after the review was recorded.

New-track IDs must not already be reserved in the library. The owner is the
verified draft owner, never a manifest field. Existing/imported library tracks
and revisions are deliberately unsupported; no legacy compatibility key is
assigned from a supplied title.

The response lists the proposed immutable manifest/audio keys, byte counts,
checksums, review summary and graph warnings. Any existing destination object
is a conflict—even identical bytes—because recovery/idempotent publication
requires a separate audit protocol. The draft's active status and exact metadata
are reread after sequential object inspections to catch changes during preflight.

`checksPassed: true` means only these point-in-time checks passed. The response
explicitly says `pointInTimeOnly: true`, `publicationAuthorized: false`,
`publishing: false`, and `serverDecoded: false`. It is **not a permit**, token,
queued job, transaction, or promise that objects cannot change afterward.

## Verification and next increments

Tests cover no D1/R2 writes, disabled/missing/aliased configuration, private
headers and HEAD, owner/administrator isolation, rejected writes, missing review,
archival, historical package expiry, altered metadata/snapshot/report/candidate/
approver/policy/scope, missing files/native checksums/changed ETags, reserved
identities, public object collisions, archival during checks, and sanitized errors.
Actual Vite- and Wrangler-bundled Workers also inspect an attestation created
through the existing review endpoint after a real local Lena's Home decoder run;
their public bucket and library tables remain empty. These are local runtime
tests, not a cloud preflight rollout or a publication walkthrough.

All **271 tests**, frontend/Worker lint, the normal frontend build, and Git
whitespace checks pass. The live player's JS/CSS bundle filenames and sizes
are unchanged. The user-owned `.gitignore` edit, generated test manifest, and
browser proof screenshots are excluded from the checkpoint.

Cloud deployment version `ab1461f4-92e3-4f92-9475-d6f7d946571a` preserves the
existing D1, both R2 buckets, RoomHub namespace, Access identifiers, and private
administrator email secret binding. No pending D1 migrations were found. The
draft bucket still has no custom domains and its public development URL remains
disabled. No migration, resource, secret, route, Access policy, or Pages changes
were made. Public health and the empty catalog returned 200; anonymous admin,
session, and publication-preview requests redirected to Cloudflare Access.

Before and after deployment, D1 contained two drafts (one archived), one asset
allocation, one immutable review, and zero published tracks/versions. The retained
Lena's Home report and snapshot checksums remained unchanged. The signed-in
browser verified the archived metadata-test draft's disabled editor, Save,
Discard, upload, review, and Archive controls before deployment. Navigating to
the newly deployed preview initially showed Brave's `ERR_BLOCKED_BY_CLIENT`;
one reload reached Cloudflare Access sign-in. No preview response was inspected,
so successful cloud checks/flags/object destinations and archived-preview
rejection are **not yet verified**. No authentication was automated, and no
draft or public object was written during this rollout.

To disable preflight, set its flag to `"false"` and redeploy the existing Worker;
this does not alter saved drafts/reviews or public storage. No rollback was needed.

Next: finish the signed-in, read-only cloud preview checks. The actual publication
implementation needs a separate
immutable publication/audit and retry design: revalidate sources, use conditional
source reads and non-overwriting destination writes, verify all public objects,
and commit D1 publication records/pointers atomically last. R2 and D1 cannot be
one transaction; interrupted copies can become publicly reachable by exact URL
before catalog publication. Public copying must therefore require explicit
publication authorization. Do not assume archived drafts/private uploads can be
recalled from a public bucket or that pointer changes delete cached objects.

Reviewed ownership/compatibility mapping for the original library, measured audio
validation of every imported track, controlled import, CORS/range/browser playback,
two-client pinned-room checks, and an explicit frontend cutover remain separate
steps. The known BleepBloop UglyOnPurpose timing failure is not silently fixed by
this preflight. Visual editing, ordinary-user identity/moderation, cleanup and
published revision workflows remain future work.
