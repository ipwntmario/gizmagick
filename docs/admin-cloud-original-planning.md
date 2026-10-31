# Phase 7U: original-track planning-only rollout

Latest follow-up: [Phase 7V](admin-cloud-original-copy.md) completes the separately
authorized two-object original Lena's Home copy test. Both files are verified
public by URL; shared/copy writes are closed again and both catalog publishers
remain disabled. The zero-copy statements below describe Phase 7U.

Deployed October 30, 2026, Eastern, after explicit planning-only authorization.
All local verification and cloud configuration readback pass. The subsequently
authorized [readiness check and private reservation](#completed-original-lenas-home-readiness-and-reservation)
are now verified. This checkpoint enables **planning**, not public copying or
catalog publication. The walkthrough is the original Lena's Home only.

## Plain-English rundown

The original track is already privately uploaded and approved. This step makes
its publishing-plan controls available: reconstruct that exact approved version,
save private readiness progress, and check the one private audio source and the
two proposed public destinations (audio and manifest). Nothing is made public.

The administrator authorized deploying this setting and preparing/checking that
plan, **not reserving it**, copying files, publishing a catalog entry, changing
the player or acting on Testing Time. The plan reservation checkbox/button is a
separate action and must remain untouched during this walkthrough.

## Scope and configuration

| Gate | Authorized value |
| --- | --- |
| `GIZMAGICK_ORIGINAL_IMPORTS_ENABLED` | `true` (unchanged) |
| `GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED` | `true` |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` (unchanged) |
| `GIZMAGICK_PUBLICATION_ENABLED` | `false` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `false` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` |

The original-specific gate's name covers the original-aware workflow, including
private readiness and reservation. It does not override the shared public-write,
copy or final-publication gates. Session capability `originalPublishing: true`
means original workflow support, **not** permission to write public files.

This is a global workflow setting for eligible administrator-owned originals,
not a server-enforced allowlist containing only Lena's Home. Testing Time would
also become eligible for planning, but this walkthrough must not prepare, reserve,
copy, publish or otherwise change it. Existing new-track intent preparation keeps
its prior availability. Public-copy/final/legacy panels remain absent.

No new code path, migration, authentication bypass, secret/Access change, bucket
permission change, room migration or Pages deployment is required. Existing
explicit owner, report, snapshot, identity and SQL guards stay intact.

## Read-only preflight

Before the rollout, 100% of traffic used Worker version
`1c8c360b-644e-4463-855e-0f28fcb97c87`, with original workflow support and all four
public-writing gates false, and ordinary bounded intent support true. Secret
binding metadata confirmed the administrator-email secret exists; its value was
not read. Migrations 0001–0011 are applied and foreign-key checks pass.

Both originals remain private with no current-version pointer, publication
intent or published version. Their original IDs/keys and owner mapping match.
Stored approvals retain their actual scopes and exact report fingerprints:

- Original Lena's Home, draft `3cef51f3-d20e-4790-bf8f-df2a1744365b`, track
  `5c22b71c-2af0-5483-8a25-821b726707e1`, private version
  `0ca37c1b-51ed-4965-9f53-fe9e4292f004`, `single-request` review.
  Report SHA-256:
  `5a81b6982086930075824b77387b2d0492e61e2335c6ed6c204ad460feb2b767`.
- Original Testing Time, draft `608a370e-6b78-421c-848c-cf23250d1857`, track
  `7031282b-1a1f-5b39-ba9e-1415052d3aad`, private version
  `d70d3a75-3bad-4928-a46e-2b6fcadda464`, `bounded-batches` review.
  Report SHA-256:
  `3586075fc23c3f4a92bc85be8ba1e57b6f95654395c7846bd006a3f5e740fdfe`.

Download-package expiry does **not** undo an already-recorded valid attestation.
The publisher reconstructs its retained immutable report/snapshot/candidate and
then requires new readiness, conditional-copy and final checks at the relevant
stages. No expired report can create a new approval, and no old approval receipt
is treated as a fresh publishing check. There is no need to reset or re-attest
these locked drafts merely because their old download packages expired.

## Added local regression evidence

The original-review fixture now supports the real Lena's Home combination:
batched package preparation, a single-request personal approval and time passing
beyond package expiry. Existing original tests still default to bounded review.

Two new tests cover:

1. The authorized planning-only configuration, using real Lena's Home source
   audio and a locally attested review. Status/preparation do not access R2;
   one readiness batch performs one private HEAD and two public destination
   HEADs. Premature reservation fails. A separately confirmed reservation in the
   **local test only** preserves the original key/review scope, copies nothing,
   leaves the catalog private, blocks all public mutation routes and recovers
   through read-only status after the original gate is closed.
2. An independently local full original workflow after package expiry: fresh
   bounded readiness/copy/final checks publish exactly one audio object and one
   manifest under the preserved original identity, while source provenance and
   the original single-request approval remain unchanged. Exact commit retry
   creates no duplicate. This is not authorization or evidence of cloud copying.

The rollout-specific configuration test requires original planning true and all
four public-writing gates false. Missing/false/invalid original-gate coverage and
closed-gate private intake coverage remain intact; assertions were deliberately
adapted to the approved combination, not removed to permit public writes.
Automated local attestations are not human attestations or cloud verification.

All **632 automated tests pass**, including both actual bundled Worker tests and
the two new original/single-request/package-expiry regressions. Frontend and
Worker-admin lint, whitespace checks and the normal production build pass.
Player assets remain `index-FinxNOWL.css` and `index-CQBPIrW7.js`.

## Cloud deployment and walkthrough

Worker version `20df9ee2-a161-4e96-8c36-9e93bbb484b1` was created at
`2026-10-30T19:37:01.980973Z` (October 30, 3:37 p.m. Eastern), and receives 100%
of traffic. Message: `Phase 7U: enable original readiness planning; public copying
and publication disabled`.

Readback matches all 18 configured variables, including the authorized original
planning gate true and all four public-writing gates false. D1/media/drafts
bindings, `ROOM_HUB` namespace `2cde201793224f49bf522d2e8adf4910` and the
administrator-email secret's presence are preserved; no secret value was read.
No migration, Pages deployment, Access policy, route/domain or bucket setting
was changed.

Post-deployment read-only queries confirm both originals retain their exact
approval scope/report hashes and private/no-current-version state. Each has zero
intent preparations and zero publications. Totals remain 4 reviews, 2 publications,
4 public copy receipts, 2 commits and 2 public tracks, with no foreign-key
violations. A public catalog GET verifies the unchanged two smoke-test track IDs
and version IDs. No actual preparation, reservation, public copy or original
catalog publication occurred in this deployment checkpoint.

Signed-in readiness checks remain pending. Do not treat the local reservation
or publication tests as evidence that those cloud operations already occurred.

After verified deployment, the administrator should sign in, open the **original
Lena's Home** (not either independently named smoke test), then under **Prepare a
bounded publication intent**:

1. Click **Refresh intent status (read only)**.
2. Click **Prepare or resume readiness checks**.
3. Click **Check next readiness batch (no public write)** to reach 2/2.
4. Stop and report the plan identity/progress. Leave the reservation checkbox
   unchecked; do not click **Reserve immutable intent (no public copies)**.

Preparation and batch checks save private D1 planning state but make no R2 PUT,
audio upload, review replacement or catalog write. Readiness checks expire;
future reservation/copy/final actions independently enforce their own exact
identity, current authority, freshness and explicit confirmations. A successful
readiness check does not grant permission to perform those actions.

The live player remains on its prior source. Rollback of this configuration
means closing the original gate again, not restoring D1, deleting records,
archiving originals or recalling public files. Existing public smoke-test files
remain public. Any future actual public write requires separately scoped approval.

## Completed original Lena's Home readiness and reservation

Completed October 30, 2026, Eastern. The administrator signed in, opened the
original Lena's Home and used the deployed intent controls to prepare/check its
two-object plan. Their initial screenshot showed 2/2 proposed objects checked,
the original identity/report/source hashes and an unchecked reservation box.
Read-only D1 verification corroborated this unreserved preparation:

- Preparation: `03f4e09d-e48e-4452-8d88-210a6e90ffc6`.
- Request: `eb661c73-be61-4bfb-b99a-9012ac29b426`.
- Plan SHA-256:
  `9dd42a2d2cb86d7967b2b82bc71f1c597bf18fc36c403dc4e2b9113d9ae96e1a`.
- One contiguous readiness batch covering objects 0–2 at epoch `1793389498`.
- Exact `bounded-original-track` mapping and approved version/report, with zero
  reserved intents. Testing Time had no preparation or publication.

The lasting nature of reservation and its no-public-copy boundary were explained,
and the administrator **separately authorized reserving this exact plan**. They
then confirmed the private intent using the deployed page and supplied its saved
status screenshot. The final reservation uses preparation/intent ID
`926c9038-c0df-4450-b385-6397c47e7850`, rather than the initial unreserved ID;
the plan SHA-256 above is unchanged. The retained final readiness batch covers
objects 0–2 at epoch `1793390303`, with preparation expiry `1793391199`.
No stale timestamps or audit records were modified to obtain reservation.

Independent read-only D1 inspection confirms:

- Intent: `926c9038-c0df-4450-b385-6397c47e7850`, state `pending`, created at
  `2026-10-30T19:58:36.000Z` (October 30, 3:58 p.m. Eastern).
- Workflow: `bounded-original-track`; original key `Lena's Home`.
- Draft/track/version remain `3cef51f3-d20e-4790-bf8f-df2a1744365b` /
  `5c22b71c-2af0-5483-8a25-821b726707e1` /
  `0ca37c1b-51ed-4965-9f53-fe9e4292f004`.
- Original source version/checksum and the original `single-request` review
  report hash match the baseline. The intent, draft, library row and provenance
  have the same owner.
- Two planned objects, zero public-copy receipts and zero commits for this
  intent. The original remains private with no current-version pointer.
- Totals: 3 intent records (two earlier published tests plus this pending plan),
  4 public-copy receipts, 2 catalog commits and 2 public tracks. Testing Time
  still has zero publishing preparations. Foreign-key checks pass.

The fixed copy targets are under
`tracks/5c22b71c-2af0-5483-8a25-821b726707e1/versions/0ca37c1b-51ed-4965-9f53-fe9e4292f004/`:

- `audio/Lena's Home.ogg`: 3,961,537 bytes, SHA-256
  `954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b`.
- `manifest.json`: 721 bytes, SHA-256
  `f50d119ecee7304168da247ef0378ade25c58bc48619a4e35b8a561921763573`.

Public HEAD requests to both proposed versioned URLs returned **404** (audio
cache MISS, manifest DYNAMIC). These are point-in-time public URL observations,
not a storage lock or future permission to overwrite. Any later copy must still
perform its independent exact-source/destination checks and conditional PUT.

The agent used only source inspection and read-only cloud/public checks for
verification; the administrator performed the authenticated form actions. No
session tokens were extracted, review was reset, original was archived or raw
D1 mutation was used. No additional code/configuration deployment or public copy
was performed after the planning-only deployment above.

The original's private publishing plan is now reserved, but its audio/manifest
are not publicly served and it is not in the public catalog. Next is reviewing a
separately authorized copy-only rollout for these **two exact objects**, keeping
legacy/final catalog publication disabled and Testing Time untouched. Actual
copying makes each object public by URL even before catalog publication, so that
public exposure must be clearly authorized before enabling/using the copy gate.
The live player remains unchanged; final verification/catalog commit and any
frontend cutover remain separate decisions.

This follow-up is a documentation/evidence checkpoint only. No new implementation
or regression run is claimed beyond the 632-test verified rollout above.
