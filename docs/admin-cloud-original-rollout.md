# Phase 7T: private-only original-library tooling rollout

Latest follow-up: [Phase 7V](admin-cloud-original-copy.md) temporarily enables the
separately authorized two-object original Lena's Home copy test, following
[Phase 7U planning and reservation](admin-cloud-original-planning.md). Both catalog
publishers remain disabled. The private-only statements below describe Phase 7T.

Deployed October 19, 2026, Eastern. Remote schema/configuration and public catalog
checks pass; the signed-in read-only admin walkthrough remains pending.
Subsequent screenshot-assisted UI verification and a separately authorized first
private original import are now recorded [below](#screenshot-assisted-check-and-first-private-original-import).
The pending-walkthrough statements describe the initial deployment checkpoint.
The first original's [private approval is now verified](#original-lenas-home-private-approval-october-28-2026);
the subsequent [Testing Time batched private approval](#testing-time-nine-batch-private-approval-verified)
is also verified. Both originals remain private and unpublished.
The administrator authorized a D1 backup, migrations 0010–0011 and Worker
deployment with original private intake enabled, **not an actual track import**.
Original publishing and all public-write gates must remain off.

## Plain-English rundown

This installs the admin tools needed to move the original library later. The
original-import form can reserve a track privately when separately confirmed;
the clip-ending helper can propose corrections to unreviewed working metadata.
Making these tools available does not run them. No track is automatically
imported, uploaded, approved or published, and the live player still uses its
existing files. The two published smoke tests remain independent test entries.

## Reviewed scope and gates

| Setting | Authorized value |
| --- | --- |
| `GIZMAGICK_ORIGINAL_IMPORTS_ENABLED` | `true` |
| `GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED` | `false` |
| `GIZMAGICK_PUBLICATION_ENABLED` | `false` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `false` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` |

Existing private uploads, metadata editing, batched packages/rechecks and
intent/preflight availability retain their settings. The original-specific
gate blocks original plan mutations too; exposing private intake does not
authorize original readiness/reservation or publication. Ordinary existing
intent status remains available without replaying writes.

No Pages deployment, frontend-source cutover, Access/secret change, route/domain
change, bucket permission change, new room migration or original audio upload
is included. The D1 and separate private/public R2 bindings must be preserved.

## Read-only baseline and recovery preparation

Active traffic was 100% on Worker version
`257b2ce8-d18f-4f11-971c-85f6143db861`, with the four public-write flags false.
Original-specific flags did not yet exist on that older deployment; absence is
not a newly enabled capability. The administrator-email secret's presence was
confirmed by binding metadata, without reading or changing its value.

D1 contained migrations 0001–0009, with only 0010 and 0011 pending. Read-only
checks confirmed 3 drafts, 2 uploaded assets, 2 reviews, 2 publications, 4 copy
receipts, 2 commits, 2 library tracks and 2 versions. Foreign-key checks returned
no violations and `quick_check` returned `ok`. Both expected smoke-test IDs and
version pointers were present in the public catalog.

After explicit authorization, a fresh Time Travel bookmark and SQL export were
captured. Ignored recovery artifacts live under `frontend/.track-manifests/`:

- `phase7t-20261019-pre-migration.sql`
- `phase7t-20261019-recovery.json`
- `phase7t-rehearse.mjs`, a local-only rehearsal/comparison helper
- `phase7t-20261019-post-migration.sql`, used for exact preservation checks

The SQL contains private application data and must not be committed or shared.
The export's SHA-256 is
`44e52d841c54fc294887658c20f53fd2f3d1f40f405842f26f52ff0124237e8c`.
The export was restored into isolated in-memory SQLite and both pending
migrations were applied through the installed Wrangler delivery splitter.
Every original column/value in all 17 application tables was preserved; integrity
and foreign-key checks passed and no original import was created. This is a
local rehearsal of a real backup, not a production restore or proof of remote
migration application.

SQL export can temporarily block database requests, as disclosed in the approval;
see [Cloudflare's export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
Time Travel recovery is time-limited; the retained SQL export is separate. A
production restore needs its own approval, since it could discard later changes.
See [Cloudflare's recovery documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## Local safety evidence

Two added regression tests cover:

- Applying 0010–0011 to an existing pre-original database containing both legacy
  and bounded published tracks, preserving every old field/value and the existing
  final-verification guard; status recovery cannot access R2 or replay writes.
- The actual authorized private configuration: original form, metadata helper
  and private review panels are available, while public mutation routes remain
  blocked. A simulated private original reservation stays invisible to the public
  catalog and creates no assets, review, publication, receipt, commit or version.

Synthetic fixture attestations are contract tests, not personal audio validation
or cloud import/review evidence. The absent-flag/default-disabled intake test
remains intact; the repository configuration assertion now explicitly requires
the approved `true` private gate and all five publishing gates `false`.

All **630 tests pass** against the authorized configuration, including both
bundled Worker tests. Frontend/Worker-admin lint and the normal production build
pass. Player output remains `index-FinxNOWL.css` and `index-CQBPIrW7.js`.

## Deployment and post-rollout checks

Both remote migrations applied successfully. The ledger now has 0001–0011, with
no pending migrations. The original intake/publication guards and retained
copy/commit/final guards are installed. The original-import table remains empty,
foreign-key checks pass, and `quick_check` returns `ok`.

A second authorized export was restored locally and compared with the backup.
Every pre-existing value in all 17 application tables matches exactly; the added
original-key column is null for the existing drafts. Counts match the baseline.
The sorted column/value snapshot digest before and after is
`7bf874c1dfdf85848bf85ee48ad9fbbfd3b5c656bd8a13eaada0acb11f1d6ad3`.
Only the new schema and migration ledger entries were added; no original
reservation, draft, upload, approval, publication or version was created.

Worker version `1c8c360b-644e-4463-855e-0f28fcb97c87` was created at
`2026-10-20T00:10:30.417409Z` (October 19, 8:10 p.m. Eastern) and receives 100%
of traffic. Deployment message: `Phase 7T: enable private original intake and
clip-end tools; public publishing disabled`.

Readback matches all 18 configured variables, with private original imports true
and all five publishing gates false. D1/media/drafts bindings, `ROOM_HUB`
namespace `2cde201793224f49bf522d2e8adf4910` and the administrator secret's presence
are preserved. No secret value was read.

The public catalog still contains only the two existing test track/version
pairs. Both public manifests match their unchanged database fingerprints:

- Earlier test: 765 bytes, SHA-256
  `eafaa0339c986cb7bb385ecd0b7a33fbce222d727f365589501cf267d573e461`.
- Batched-review test: 764 bytes, SHA-256
  `6801e9eb95bdd24e8f14c395d6840d9a1812733bd2b47ae4f9c50809d81d4987`.

Public audio HEAD sizes match each unchanged manifest's recorded byte length.
These are size checks, not a fresh download/checksum of the audio bytes.

The local player build was checked but was not deployed to Pages. No cloud
import/upload/approval/publication or signed-in admin form submission was made.
This checkpoint verifies schema delivery, data preservation and active config,
not a real original's cloud workflow or the authenticated browser walkthrough.

## Next step and recovery boundaries

After deployment checks, a signed-in read-only admin walkthrough must verify the
original form and clip-ending controls and recover an existing draft without
changing it. Cloudflare Access sign-in belongs to the administrator; do not bypass
it or extract session tokens. Local bundled-page tests do not replace that check.

Then obtain separate approval for **one** original's private reservation/upload,
using its pinned source manifest and authenticated administrator owner. Fresh
personal validation/review remains necessary. Larger-track cloud verification,
public publication, player cutover, published-track revisions and cleanup remain
separate steps. Neither published smoke test should be adopted by title or deleted.

For a tooling issue, first close the private-import gate or redeploy the last
reviewed code/config; do not reverse applied migrations or restore the database
automatically. A failed deployment leaves schema verification and active traffic
as separate facts to inspect. Turning a flag off does not undo a private identity
reservation or remove already-public files. No remote restore/rollback is part
of this rollout's authority.

## Screenshot-assisted check and first private original import

The administrator signed in and supplied screenshots showing administrator
verification, private-only intake, recent drafts and the original-import mode.
The new form showed no selected file or checked reservation confirmation during
the read-only check. On the existing approved batched-review test, the clip-end
export, picker and Apply controls appeared disabled, as expected.

Windows computer use had stopped because it could not confidently determine the
browser URL. No workaround, session-token extraction or raw database mutation
was used. These are administrator-provided screenshot observations, **not an
automated browser interaction or independent test of every disabled control**.

The administrator separately approved using the **original Lena's Home** for one
private reservation and manifest/audio upload, with no approval or publication.
Before submission, a read-only remote check found no matching library reservation,
original import or draft by original track ID/key. One Cloudflare API request
returned account-authorization error 7403; a single identical read-only retry
succeeded. No credentials or permissions were changed.

The local pinned source matched the original allowlist, and a fresh full decode
passed: one Opus file, stereo, 48 kHz, exactly 180 seconds, 3,961,537 bytes. The
administrator then selected the original workflow/key/source manifest, confirmed
the private identity reservation and uploaded the original Ogg using the deployed
page. They supplied screenshots of the resulting unreviewed editor, original
metadata, no graph warnings and no administrator attestation. The clip-end export
and picker were available for this unreviewed draft, with no proposal selected;
no endpoint edit was requested or needed.

Independent read-only D1 verification confirms:

- Original key: `Lena's Home`; retained track ID:
  `5c22b71c-2af0-5483-8a25-821b726707e1`.
- Draft: `3cef51f3-d20e-4790-bf8f-df2a1744365b`; fresh private version:
  `0ca37c1b-51ed-4965-9f53-fe9e4292f004`.
- Immutable source version: `eaed4e03-9e2d-51e7-970c-15bb894a8bbe`; source manifest
  SHA-256: `17ad6b83aab2617f665b9427d8c9ba672040c198ae7a5d96752b8459d7897e0a`.
- Draft, reservation and provenance have the same owner. Working metadata equals
  the immutable source except for the fresh version ID.
- Reservation is private/draft with no current-version pointer. This original
  has zero review, publication and published-version rows.
- Asset `628e2a15-5748-5b9d-b521-a2eb28fe2f42` has an `uploaded` record for
  3,961,537 bytes, SHA-256
  `954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b`.
- Counts are now 1 original import, 4 drafts and 3 uploaded assets. Existing
  reviews/publications/commits stay at 2 each, receipts at 4 and public tracks at 2.
  Foreign-key checks return no violations.

The upload record matches the expected original bytes; it is not a fresh R2 HEAD
or download/decode of the stored object. No new cloud review package, personal
validation, attestation, publication intent or public copy was performed by the
agent. The existing two public smoke tests and checked-in source files were not
modified, and no player/configuration deployment was made for this test.

Next: prepare a fresh batched review package for **this exact draft**, then have
the administrator personally run the pinned local validator and inspect the
report. Read-only storage inspection and reload recovery can be checked too.
Personal-run confirmation, approval rechecks/attestation and any future public
publishing remain separate actions. Do not reuse either smoke test's old package,
and do not recreate or archive this original reservation to retry it.

This follow-up changes documentation only. No source/configuration change or new
test run is claimed; the preceding implementation checkpoint passed 630 tests.

## Original Lena's Home private approval: October 28, 2026

The administrator downloaded the exact first package and personally ran the
pinned validator on October 19, confirming exit 0, `valid: true` and 180 seconds.
The agent independently checked its identity, snapshot checksum and successful
report contract. No personal-run statement was asserted on the administrator's
behalf. Before approval resumed on October 28, the original package was correctly
found expired; the old report was not reused or its expiry changed.

The expired-preparation refresh rejects that record, clearing the browser's local
preparation state and leaving Restart disabled. The initially given Restart
instruction was corrected after source inspection: **Start or resume package
preparation** replaces an expired preparation for the same draft/audio. The
administrator completed a fresh one-file batch and downloaded a replacement,
then personally reran the validator and confirmed the successful measurements.

Fresh package and report evidence:

- Job: `a633c48d-257f-4052-8a2a-b31bc44c32ea`.
- Package expiry: `2026-10-30T00:54:30Z` (October 29, 8:54 p.m. Eastern).
- Draft and private version remain `3cef51f3-d20e-4790-bf8f-df2a1744365b` /
  `0ca37c1b-51ed-4965-9f53-fe9e4292f004`.
- Snapshot SHA-256:
  `8c43b97f2abd13c236535180796ba2961aaa7943d32732c4848f890f569db661`.
- Manifest SHA-256:
  `beb2fcd462dad47979f93649b79b121d843ca9998c0d4b289b4d3bc37d8d1cb0`.
- Report SHA-256:
  `5a81b6982086930075824b77387b2d0492e61e2335c6ed6c204ad460feb2b767`.
- Exact expected audio checksum/size, 180 seconds, no errors or graph warnings.

The administrator explicitly authorized private approval. The planned walkthrough
used bounded approval rechecks, but they reported clicking the single-request
attestation button instead. Read-only D1 inspection confirms a successful
`administrator-attested` record with **`single-request`** storage scope, approved
at `2026-10-29T01:03:15.409Z` (October 28, 9:03 p.m. Eastern), bound to the fresh
job/report/snapshot above. The reviewer matches the draft/reservation owner.
There is no bounded verification pass for this original; do not relabel this
approval or claim the original's batched approval path has been cloud-tested.

This is a supported full private-storage recheck for the one-file original,
not a failed or partial batched approval. Existing publishing-plan code accepts
either supported review scope while preserving its actual audit. The app has no
review undo/conversion workflow; no record was deleted, rewritten, archived or
recreated to change scope. Metadata is now locked as reviewed. The agent made
no attestation API call or raw database write.

Subsequent read-only verification confirms the original remains private, has no
current-version pointer, publication intent or published-version rows, and passes
foreign-key checks. Totals are 3 reviews, 2 publications, 2 commits and 2 public
tracks; the earlier public smoke tests remain independent and unchanged.
Publication and player cutover remain unauthorized and disabled.

## Next multi-file private test: Testing Time

Update: the authorized private import/upload is now verified below. The following
preflight statements describe the state before the administrator submitted it.

The administrator explicitly approved reserving and uploading the **original
Testing Time privately**, not approving or publishing it and not changing
Lena's Home. No Testing Time cloud mutation was performed for this preflight.

A fresh full local audit succeeds for all 129 assets (21,700,676 bytes, about
21.7 MB), 162 clips and 82 sections, with no errors or warnings. All source
metadata/audio fingerprints match the pinned original snapshot:

- Track ID: `7031282b-1a1f-5b39-ba9e-1415052d3aad`.
- Source version: `79f945fe-8301-5c3d-8266-b9a09ba350d8`.
- Source manifest SHA-256:
  `468875621bfdccb9c349bd1867aa1863ccc4f3512171a3c759f861aff5b21036`.

Read-only D1 queries find zero matching library identities, original imports or
drafts by this original's ID/key. This is a point-in-time collision check, not a
reservation or public-destination check. The authenticated intake must enforce
collisions and bind the owner again at the actual submission.

Next: the administrator selects original-library mode, Testing Time and its
checked-in manifest, confirms the private identity reservation and uploads all
129 referenced Oggs through the existing private uploader. If interrupted, stop
and recover the same draft; do not create another original or archive this one.
Verify the new draft/upload records before fresh review-package preparation and
personal local validation. At 16 files per request, a complete package/check pass
will require nine batches. Actual Testing Time cloud upload, private batched
approval, any public copy and publication are **not yet verified** here.

This checkpoint records cloud/local evidence only; it changes no application
code, flags, schema or live frontend. No full regression rerun is claimed.

## Testing Time private import and 129-file upload verified

On October 28, 2026, the administrator completed the original-library import and
selected/uploaded all 129 Oggs through the deployed private uploader. Their
screenshot shows the original Testing Time header, zero missing files, private
file download links and original publication disabled. `NOT server-decoded` is
expected: intake does not claim server audio decoding.

Independent read-only D1 checks confirm:

- Draft: `608a370e-6b78-421c-848c-cf23250d1857`.
- Retained original track ID/key: `7031282b-1a1f-5b39-ba9e-1415052d3aad` /
  `Testing Time`.
- Fresh private version: `d70d3a75-3bad-4928-a46e-2b6fcadda464`.
- Source version/checksum match the pinned preflight snapshot above. The draft,
  library reservation and source provenance share the same owner; working
  metadata equals the source except for the fresh version ID.
- All 129 expected upload records are `uploaded`, totaling 21,700,676 bytes.
  Each expected asset ID has exactly the source's size and SHA-256, with zero
  missing or mismatched assets. The graph retains 162 clips and 82 sections.
- The reservation is private/draft, with no current-version pointer. There are
  zero review, publication or published-version rows for this original.
- Totals: 2 original imports, 5 drafts, 132 uploaded assets, 3 reviews,
  2 publications, 4 copy receipts, 2 commits and 2 public tracks. Foreign-key
  checks pass. The preceding Lena's Home approval/public smoke tests are retained.

These checks verify the private upload records, not a fresh HEAD or full decode
of all stored R2 objects. No review package, personal validator run, batched
attestation or public publication for this new draft is claimed. No source,
configuration, database schema or frontend deployment was changed for this test.

Next: start/resume **batched** review-package preparation for this exact draft;
check nine batches (up to 16 files per request) until 129/129; then finish and
download the package. Preserve it separately from Lena's Home's packages/reports.
The administrator must personally run the pinned local validator on that exact
package before any personal-run confirmation or separately approved attestation.
Do not use the single-request package/review route for this larger track.

## Testing Time nine-batch private approval verified

Completed October 28, 2026, Eastern. The administrator prepared the exact private
Testing Time package through nine requests, downloaded it and personally ran the
pinned local validator against all 129 source audio files. They confirmed exit 0,
`valid: true`, 129 measurements and no errors. Independent local contract checks
confirm all expected byte lengths/checksums and no graph warnings. No agent-run
decoder result was substituted for the administrator's personal-run assertion.

Read-only D1 checks corroborate nine package-preparation receipts, covering
offsets 0–16, 16–32, 32–48, 48–64, 64–80, 80–96, 96–112, 112–128 and 128–129.
The stored package job/snapshot match the downloaded package:

- Package job: `abae004c-5f0c-44f5-98d3-3d6ed118a1ef`.
- Draft: `608a370e-6b78-421c-848c-cf23250d1857`; private version:
  `d70d3a75-3bad-4928-a46e-2b6fcadda464`.
- Snapshot SHA-256:
  `083490ec784105f029c9a8cd13c160fbd5a12d7993b0a3eec66c52f604fb92d8`.
- Manifest SHA-256:
  `90f3e653074234481ae533773b19d91f6d84af98faaf2eaad763a0f0f9ac49b3`.
- Report SHA-256:
  `3586075fc23c3f4a92bc85be8ba1e57b6f95654395c7846bd006a3f5e740fdfe`.

The administrator explicitly authorized private batched approval. Initially,
the enabled Start button produced `Failed to fetch`, displayed in the top-page
status area rather than beside the distant button. Read-only checks found no
saved verification pass or approval; the package was unexpired, the 50,295-byte
report was within limits, and public Worker health returned 200. Source inspection
and [Cloudflare's session documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax)
identified an expired Access-session
redirect as a plausible cause, **not a confirmed network diagnosis**. No HTTP
trace/log proved its cause, and no app/Access configuration fix was deployed.

After reload/sign-in guidance, the administrator reported reaching 129/129.
The final checkbox was initially disabled because starting a pass deliberately
clears the earlier personal-run confirmation. The requirement to recheck that
first checkbox was explained, then the administrator reported clicking
**Record batched administrator attestation (keep private)**. No agent clicked
either personal confirmation or called the attestation endpoint.

Independent read-only D1 verification confirms:

- Scope: `administrator-attested`, storage scope **`bounded-batches`**.
- Verification ID: `f69e65a1-30a9-44e0-808e-99e3e7bb9330`, bound to the exact
  package, report, snapshot and original-owner mapping above.
- Nine approval recheck receipts, contiguous from offset 0 to 129. These are
  separate from the earlier nine package-preparation receipts.
- Recorded check window: epochs `1793239403` through `1793239426`.
  Approval timestamp: `2026-10-29T02:06:33.469Z` (October 28, 10:06 p.m. Eastern).
  The oldest file-check batch was approximately 190 seconds old at approval,
  within the five-minute limit. The checks are separate point-in-time checks,
  not an atomic snapshot of D1 and R2 or server-side audio decoding.
- Original track ID/key and owner remain unchanged. Working metadata still
  equals the pinned source except for its fresh private version ID; the review
  is now persisted and metadata editing remains locked.
- Reservation remains private with no current-version pointer. There are zero
  publication intents and published-version rows for this original.
- Totals: 4 reviews, 2 publications, 4 public copy receipts, 2 commits and
  2 public tracks. Foreign-key checks return no violations.

An initial read-only verification query encountered the previously observed
Cloudflare 7403 account-authorization error; one identical retry succeeded.
There was no credential change, raw database mutation, review reset, re-upload,
new Worker/Pages deployment or public write for this checkpoint. Lena's Home's
single-request approval and the two published smoke tests remain separate.

This completes real cloud private intake/upload, batched package preparation,
personal local validation and bounded approval for the 129-file original. It
does **not** verify original-track public copying/catalog publication, remote
playback/rooms or frontend cutover. Published revisions, cleanup and multi-user
uploads remain separate work.

Next: review a controlled original-publication rollout, keeping public-write
gates off until separately authorized. Any original plan preparation/reservation,
public exposure/copy and catalog commit need their own scope and confirmations;
do not treat the saved private approval as permission to publish. Begin with the
small approved original before attempting 130 public objects for Testing Time.

This is a documentation/evidence checkpoint only; no full regression rerun or
new code/configuration change is claimed. The implementation baseline remains
the previously verified 630-test checkpoint.
