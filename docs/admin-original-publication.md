# Phase 7R: bounded first publication of imported originals

Latest next-original checkpoint: [Phase 7X](admin-cloud-testing-time-planning.md)
verifies Testing Time's private starting state and guides readiness/reservation
with all public-writing gates still disabled. No Testing Time copy or catalog
publication has occurred at this checkpoint.

Latest rollout: [Phase 7W](admin-cloud-original-final.md) completes original Lena's
Home catalog publication after its two public files were verified in
[Phase 7V](admin-cloud-original-copy.md). Shared/copy/final writes are closed again;
the statements below retain their historical checkpoint context.

Current cloud status: [Phase 7T](admin-cloud-original-rollout.md) installs the
schema/code with original publishing and all public-write gates still disabled.
The local-only statements below describe the historical Phase 7R checkpoint.

Current local follow-up: [Phase 7S](clip-end-preparation.md) adds explicit
preview/apply preparation of missing or overlong clip endings in unreviewed
working metadata. The endpoint-preparation statements below describe the
historical Phase 7R checkpoint; source documents and cloud state remain unchanged.

Implemented and tested locally. **No Cloudflare migration, deployment, upload,
reservation or publication occurred here.** Original intake and publication have
separate flags, both false in `worker/wrangler.toml`. Shared public-copy, final
publication and legacy-publication gates also remain false. The live player is
unchanged. Migrations 0010–0011 still need a separately reviewed cloud rollout.

## Plain-English rundown

An imported original already has a private database reservation holding its old
track ID, catalog name and administrator owner. Publishing must use that exact
reservation rather than create another unrelated track or take over an existing
public one.

The bounded workflow can now do that: review the exact private files, save a
fixed publishing plan that includes the original mapping, copy one confirmed
object at a time, check originals and copies again in small groups, then
separately confirm adding the first version to the catalog. The owner and old
catalog name remain unchanged. Existing preferences keep the same compatibility
key. The legacy publisher cannot perform this operation.

This does **not** update an already-published track. A reservation must still be
private, unpublished, without a current version pointer or any version rows.
Published-track revisions/clip replacement remain a separate feature. It also
does not automatically import the library or enable remote playback in the app.

## Gates and plan identity

`GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED` requires the exact string `"true"` for
original mutations. The existing intent/preflight, public-write/copy and final
gates retain their independent meanings. Enabling original support alone cannot
copy files or commit the catalog. Original mutations fail closed without migration
0011's identity fence; intake remains separately gated by migration 0010.

The server reconstructs the existing exact administrator review and allocation
snapshot. For an original it additionally verifies:

- The immutable intake source matches the pinned repository allowlist, including
  its compact-JSON checksum and original source version ID.
- The authenticated administrator owns both the private draft and library
  reservation; original track ID and legacy catalog key match all records.
- The reservation is still private/draft, with no public pointer or version rows.

The saved plan remains `planVersion: 2`, with workflow
`bounded-original-track` and an `originalImport` object containing `legacyKey`,
`sourceVersionId`, and `sourceManifestSha256`. The top-level owner/draft IDs and
candidate track/version IDs bind those fields to the exact operation. Ordinary
new tracks keep their existing `bounded-new-track` plans without that extra field;
existing saved plans are not rewritten.

Preparation, source/destination batches, reservation, each conditional copy and
each final batch retain their existing checks and fresh confirmations. Current
original authority is reconstructed before each write and fenced again in SQL.
No earlier readiness response is itself permission to publish.

## Database changes

Migration 0011 adds two read-only views: current private original authority and
publication identity authority. It adds an intent-insertion guard and replaces
the receipt/base-commit identity predicates so that they allow either:

1. An ordinary new track with an unused library identity; or
2. An exact original first-publication plan backed by its private reservation.

The remaining receipt and commit conditions are preserved: lease ownership,
active draft, exact reviewed metadata/report/package, uploaded allocations,
receipt order and completeness. Migration 0009's independent recent final-check
guard remains installed unchanged. Both original and new bounded plans still
require that final guard. A disguised original using a legacy/new-track plan,
wrong key/source mapping or already-public reservation is rejected by SQL too.

The atomic commit creates the published version and advances the existing
original reservation to public/current. It does **not** insert a second track or
change owner/key/source provenance. Ordinary new-track commits still create their
new track row. Failure rolls the complete commit back, leaving the original
private reservation and prior copy receipts intact. As before, already-public
files are not recalled by a failed database operation or archival.

SQLite does not guarantee ordering between independent BEFORE triggers. Tests
that submit an obviously forged raw commit accept rejection by either the base
authority guard or final-verification guard; both remain enforced. Earlier
migration files 0001–0010 are unchanged.

## Admin controls and recovery

Draft details expose the immutable original mapping and whether original
publication support is configured. When enabled, eligible originals use only the
existing bounded intent/copy/final panels; the legacy panel stays hidden and its
API routes reject originals regardless of its flag.

The identity panels show the original catalog key and source checksum. The
browser validates the mapping in preparation, reserved-intent and final responses
against the loaded draft, rejecting a changed/missing mapping before enabling
continuation. Existing separate exposure, copy and final-publication confirmations
still apply. Loading or refreshing never resumes a write automatically.

With intent status enabled, closing the original-specific gate prevents further
mutations but still permits read-only intent recovery, including its preserved
mapping and published state. Disabling public writes does not remove public files
or catalog records. The final-status endpoint retains its existing overall final
gate; do not interpret a disabled endpoint as proof that nothing was published.

## Local evidence and boundaries

On October 18, 2026, all **592 automated tests pass**, including 17 new original
publication/UI tests and both extended bundled Worker tests. Frontend and
Worker-admin lint pass. The normal production build passes with unchanged player
assets `index-FinxNOWL.css` and `index-CQBPIrW7.js`.

The local tests fully decode and upload original Lena's Home and **Testing Time's
129 real audio assets**, prepare/attest exact packages in batches, reserve plans,
conditionally copy audio/manifest, perform bounded final checks and commit using
the original catalog keys. Testing Time retains its 162 clips and 82 sections.
Automated test attestations are **not human attestations or cloud verification**.

Regression coverage includes the original-specific flag and missing migration,
changed private reservation/owner/key, a visibility race after a public PUT,
conditional recovery of the intent-marked object, commit rollback and lost-reply
recovery. Direct-SQL substitutions of a legacy plan, ordinary-new-track plan or
different original key fail even with recent preparation. UI tests cover full
original continuation and rejected mapping responses.

Both Vite- and Wrangler-bundled Worker tests also publish the real one-file
original through simulated D1/R2 and verify its compatibility-key catalog entry.
The installed migration delivery splitter compiles all eleven migrations. These
are local integration checks, not proof that remote migrations or real cloud
large-track publication have succeeded.

The accepted `clipEnd` default rule remains documented in
[metadata preparation](admin-original-imports.md#accepted-clipend-behavior-for-the-metadata-preparation-step),
not implemented here. No original musical data or audio was edited; malformed
UglyOnPurpose still cannot pass measured review unchanged.

## Next steps

Implement and test the agreed unreviewed `clipEnd` preparation behavior before
reviewing corrected/defaulted imports. Then review a private-only Cloudflare
rollout of the import/schema changes, with original publication and public writes
off. Obtain explicit authorization before creating any real original reservation
or private upload. Real review/public copying/catalog publication and player
cutover require their own confirmations and verification. Preserve the two cloud
smoke tests and legacy playback for rollback unless cleanup is separately approved.
