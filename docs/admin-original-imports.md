# Phase 7Q: identity-preserving private intake for original tracks

The agreed endpoint editing helper is now implemented locally in
[Phase 7S](clip-end-preparation.md). It changes only unreviewed working metadata
after explicit preview/apply/save, not the pinned original intake documents.

Current local implementation: [Phase 7R](admin-original-publication.md) adds a
separately gated bounded first-publication path for preserved original identities.
It remains disabled and undeployed. The private-only publishing limitations below
describe the historical Phase 7Q checkpoint, not permission to use the new path.

Implemented and tested **locally**. The repository keeps
`GIZMAGICK_ORIGINAL_IMPORTS_ENABLED = "false"`. Migration 0010 has not been
applied remotely, the Worker has not been deployed, and no cloud track, upload,
reservation or publication was created in this step. The live player is unchanged.

## Plain-English rundown

The original tracks must not become unrelated copies during migration. This
workflow preserves each original's track ID and old catalog name, assigns the
signed-in administrator as its owner, and gives the private working copy a fresh
version ID. It starts with the existing checked-in combined manifest; audio is
uploaded separately through the existing private uploader.

The database saves three things together: a **private identity reservation**, a
private draft, and a permanent record of the original source snapshot. Either
all three save or none do. Reserving an identity does not list a track publicly,
create a published version, copy a file or change anyone's current playback.

This is initial import, **not editing an already-published track**. The current
new-track publisher cannot publish these preserved identities. Both the API and
the admin page keep that continuation locked, even if general publishing flags
are enabled. The publisher must explicitly support original compatibility keys
before a later rollout can publish them.

## Fixed original identities, not a replacement music database

`shared/original-library.js` pins the 13 original catalog keys, track IDs,
source snapshot version IDs and compact-JSON manifest checksums verified by the
[local library audit](original-library-import.md). Tests compare every entry with
the actual checked-in manifest. This is a one-time migration allowlist, **not**
the public catalog, user authorization or an audio approval. Normal new music
does not get added to this list. Later editing/upload conveniences should not
require Git changes for music updates.

The source manifest's formatting may differ, but its parsed JSON serialization
must match the pinned checksum (including property order). A changed source
snapshot fails closed instead of silently importing stale/different data. Source
allowlist changes require a deliberate local review; private metadata can be
edited afterward through the existing unreviewed-draft editor, without rewriting
the immutable source record. Fingerprints remain upload constraints, not proof of
server-side audio decoding.

Original Lena's Home keeps ID `5c22b71c-2af0-5483-8a25-821b726707e1`.
The two differently identified cloud smoke tests are never adopted by title,
filename or matching audio hash. They remain separate records.

## API and admin form

All routes use the existing Cloudflare Access, admin allowlist, same-origin and
request-header checks. A verified `admin` role and opaque `access:` principal ID
are required. The new flag also requires enabled, distinctly private draft storage.
Migration 0010 is checked before any import writes.

- `GET/HEAD /api/admin/original-imports` returns the fixed source identities and
  the current administrator's expected owner ID. It makes no storage calls.
- `POST /api/admin/original-imports` accepts only `requestId`, `legacyKey`,
  `expectedOwnerId`, `sourceManifest` and `importConfirmed: true`. The expected
  owner must equal the authenticated principal; a manifest cannot select an owner.
- Body, graph, audio constraints and quotas retain the existing private-intake
  limits. No duration or `clipEnd` is guessed or modified in this increment.
- Exact request retries return the saved draft, including after archival. Changed
  content under the same request ID conflicts; a different request ID cannot
  create a second reservation for the same original.

When explicitly enabled, the existing form offers **Import an original library
track (preserve identity, private only)**. Select the original catalog key and
its checked-in `manifest.json`, then explicitly confirm the private reservation.
Source/key changes clear that confirmation. The page retains the same request
body after an interrupted response; it never retries automatically or imports the
rest of the library. After success, confirmation is cleared and audio can be
uploaded separately. Draft reloads remain read-only.

Original drafts are labeled private-only, with publication panels hidden and
publication eligibility disabled. The server independently rejects all five
publication/preflight/intent/final routes for these drafts, so hiding controls is
not the safeguard. The existing new-track workflows retain their fresh identities.

## Database and collision boundaries

Migration 0010 adds `admin_drafts.original_legacy_key` and the immutable
`admin_original_imports` source record. The initial reservation uses
`library_tracks` with `visibility = private`, `status = draft` and no current
version pointer. It adds **no `library_track_versions` row**. Public catalog and
pinned-version APIs exclude this reservation.

Unique track IDs/legacy keys reject existing library identities, including
same-owner private rows. The final batch trigger also rejects pre-existing
draft identities, publication intents and preparations that reserve the track.
An atomic quota trigger enforces the existing 20-active-draft limit. If the last
insert fails, both earlier inserts roll back. Conflict responses do not adopt or
disclose another owner's records.

The import source record, draft identity and original owner/key mapping are
immutable. The ordinary editor may still change unreviewed musical metadata
while retaining track/version IDs and the complete assets object. Existing
attestation and archival locks remain intact. Archiving keeps the identity and
private files reserved; there is no delete, undo, owner-transfer or reimport
workflow yet. A later release needs explicit handling for those operations.

Intake makes **no R2 calls**. It does not claim that public destinations are empty
or that private audio is valid. Fresh conditional destination checks, exact review
packages, personal validation/attestation and the guarded original publisher must
precede any future public write. No D1/R2 atomic snapshot is claimed.

## Accepted `clipEnd` behavior for the metadata-preparation step

The administrator confirmed this intended default:

- If `clipEnd` is absent or exceeds the measured audio duration, use the measured
  file duration.
- Keep a supplied shorter endpoint as an intentional trim.
- Keep `loopPoint` as authored; if it lies beyond the usable end, require a musical
  correction rather than guessing a new transition time.

This rule is **recorded, not implemented here**. Apply it to unreviewed metadata
before producing the exact review package, never silently to an attested or
published version. Multiple mode files share a clip endpoint today; differing
durations need an explicit policy/check before automatic defaults are enabled.
The intentionally malformed UglyOnPurpose source remains unchanged and still
cannot pass measured review as-is. Including a source in the intake allowlist
does not approve it or select it for a real import.

## Verification and next steps

On October 18, 2026, all **575 automated tests pass**, including 16 new intake/UI
tests and the extended bundled Worker checks.

Local checks cover the exact 13-track allowlist, retained IDs/keys, fresh versions,
explicit owner/confirmation, disabled/missing-migration behavior, source changes,
quotas, conflicting identities and rollback. Testing Time's actual 129-asset,
162-clip, 82-section metadata imports privately without file checks or approval.
The real original Lena's Home upload/decoder/review works while every publisher
remains locked. Browser-script tests cover confirmation reset, exact retry bodies
and hidden/disabled publication controls; they are not cloud-browser evidence.

Both Vite- and Wrangler-bundled Worker tests exercise the new authenticated route,
private real-audio upload, exact retry, preserved mapping and actual Miniflare D1
batch rollback. Existing new-track publishing regressions still run with migration
0010 installed. The installed Wrangler delivery splitter compiles all ten
migrations; this does not establish remote migration compatibility by itself.
Frontend and Worker-admin lint and the normal production build pass. The player
assets remain `index-FinxNOWL.css` and `index-CQBPIrW7.js`, unchanged from Phase 7P.

Next: add separately gated original-track publication support that binds the
immutable owner/key/source mapping into readiness, intents and final commit,
preserving all current public-copy/review safeguards. Then review a private-only
cloud rollout and obtain approval for any real original import. Before reviewing
corrected/defaulted clip endings, implement the metadata-preparation rule above.
Large-track cloud verification, existing published-track revisions and explicit
frontend release/cutover remain later work.
