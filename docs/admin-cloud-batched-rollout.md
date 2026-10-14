# Phase 7L: private-only Cloudflare rollout

Completed October 13, 2026. Migrations **0001–0009** are applied to
`gizmagick-library`, and the bounded-workflow code is deployed to
`gizmagick-worker`. Only private batched package preparation and private approval
rechecks are newly enabled. Intent preparation, public copying and final catalog
publication remain disabled. No new draft, audio upload, attestation or public
object/catalog entry was created for this rollout.

Subsequent private integration is now verified end to end for one fresh Lena's
Home test draft, including the administrator's personal validator run and
batched attestation. See the [completed private-review record](#completed-private-batched-review-october-13-2026-eastern).
All public-write switches remain off; the live player has not been migrated.

## Plain-English rundown

The new database structure and admin code are now on Cloudflare. The admin page
can prepare local-validator packages and recheck private audio in small groups.
These actions do not publish music. The publishing portions are installed but
their switches remain off, so this is not the live-library migration or player
cutover. A fresh private workflow test is still needed before a public test.

## Deployed configuration

Worker version: `fa9bff52-6c1c-4e46-9e5d-85229d20ef7d`, created
`2026-10-13T16:55:21.441135Z`.

Deployment message: `Phase 7L: deploy private batched review with public writes disabled`.

```toml
GIZMAGICK_REVIEW_PACKAGE_BATCHES_ENABLED = "true"
GIZMAGICK_REVIEW_VERIFICATION_BATCHES_ENABLED = "true"
GIZMAGICK_PUBLICATION_INTENTS_ENABLED = "false"
GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = "false"
GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = "false"
GIZMAGICK_PUBLICATION_ENABLED = "false"
```

D1 remains `bb2ac5dd-05af-4e2f-8a4b-51120fac5da4`; private/public buckets remain
`gizmagick-drafts` / `gizmagick-media`. The `ROOM_HUB` namespace remains
`2cde201793224f49bf522d2e8adf4910`. The existing administrator-email secret is
present; its value was not read or changed. No Pages deployment, domain/route
configuration change, original-library upload or frontend-source cutover was
performed. Existing public files remain public even with writing disabled.

## Recovery preparation and migration compatibility fix

Before schema changes, a [D1 Time Travel bookmark](https://developers.cloudflare.com/d1/reference/time-travel/)
and [SQL export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
were captured. Recovery artifacts are ignored local files under
`frontend/.track-manifests/phase7l-*`, including
`phase7l-20261013-pre-migration.sql`. They contain private database data and must
not be staged or published. No production restore was attempted or authorized.
Time Travel recovery availability is time-limited; the SQL export is retained.

The exported database was restored into an isolated in-memory SQLite database.
Foreign-key enforcement was temporarily off during this local import because
the export inserts forward-referencing tables before their targets are created;
it was enabled afterward. Foreign-key/integrity checks passed. Revised migrations
0005–0009 were rehearsed through the installed delivery splitter, preserving
every original column/value in the nine existing application tables. No cloud
foreign-key settings were changed.

An initial database query returned an authorization error, while subsequent
read-only checks succeeded with the same login; no credential changes were made.
Migration 0005 applied, but remote D1 rejected migration 0006 with
`incomplete input: SQLITE_ERROR`. Its transaction rolled back fully: inspection
confirmed no 0006 tables/columns/guard and no 0006 ledger entry. The old Worker
remained deployed while this was investigated.

Before their first successful application, migrations 0006–0009 were rewritten
from compound `SELECT CASE ... RAISE ... END` guard bodies to equivalent
`WHEN ... AND NOT EXISTS (...) BEGIN SELECT RAISE ... END` triggers. This uses the
guard style already deployed in migration 0004; no predicates or safety checks
were removed. Local guard tests and the exported-data rehearsal passed; remote
D1 then accepted all remaining migrations. A delivery-splitter/style regression
test was added. The exact remote parser implementation is not assumed.
Future changes to these now-applied migrations must use a new migration version,
not edit or rerun the applied files. See [Cloudflare's migration ledger rules](https://developers.cloudflare.com/d1/reference/migrations/).

## Cloud verification

Read-only checks confirm:

- No pending migrations and all four new guard triggers present.
- Existing counts unchanged: two drafts, one asset/review/publication/commit/track/
  version, and two copy receipts. All new preparation/pass tables remain empty.
- The original published plan, review snapshot/report/manifest fingerprints and
  track/version identifiers are unchanged. Old review/commit records retain
  their `single-request` scope, with no invented bounded-final audit.
- No foreign-key violations. The public catalog still contains only the original
  Lena's Home test track; public manifest/audio GETs match the original hashes
  and sizes (765 and 3,961,537 bytes).
- Deployed private-review flags are true; all four new/public intent/copy/final/
  publication flags are false. Existing D1/R2/room bindings and secret presence
  match the prior deployment.

After the user renewed Cloudflare Access sign-in, the actual admin page loaded
the existing draft and displayed both private batched-review panels. No publishing,
intent, copy or final-commit panels appeared. A read-only private-storage check
completed `1/1` with the original SHA-256 and byte length, explicitly granting no
approval or publishing permission. The legacy attestation remains locked; the
batched-recheck status request rejected it as a different immutable attestation.
This is expected preservation of the original review, not a new batched review.

No fresh cloud package/pass/attestation was created: this checkpoint verifies
deployment, migration compatibility, read-only integration and protected existing
data, not an end-to-end cloud write test of the new private workflow. Screenshot
proof is retained in ignored `phase7l-private-rollout.jpg` and
`phase7l-private-review.jpg` artifacts. No browser auth tokens were extracted.

## Local verification and next step

All **531 tests** pass with isolated test-file execution. One parallel run had a
local Miniflare `ECONNRESET`; the full rerun using `--test-concurrency=1` passed.
Focused migration/guard/bundled-runtime checks also passed. Frontend/Worker lint,
normal build and whitespace checks pass. The normal player outputs remain
`index-FinxNOWL.css` (250.25 kB) and `index-CQBPIrW7.js` (387.48 kB).

Next: obtain approval for one fresh private-only test draft, then test batched
package preparation, the pinned local validator and private approval rechecks
through the deployed page. Preserve the administrator's personal-validation
confirmation; an agent's decoder run is not a substitute for that assertion.
Only after private integration is verified should intent preparation or any
separately authorized public-copy/publication test be enabled. The existing
published test must not be reused as an assumed rollback or modified for this.
Original-library ownership/mapping/import, the known BleepBloop UglyOnPurpose
timing issue, two-client pinned-room verification and the live player cutover
remain separate steps.

## Authorized private package smoke test (October 13, 2026)

After the administrator approved one fresh private test and renewed sign-in,
the browser connection recovered. Through the deployed admin page, the agent
created **Lena's Home (batched review check)** from the existing JSON pair,
selected first section `Lena's Home`, marked it simple/test, and uploaded the
existing Ogg file. This did not reuse or modify the original published test.

- Draft: `405b26f8-fd51-4f82-b3d7-9f676056eb72`.
- Version: `5bc50912-36f2-4328-80f6-11602a2bddab`.
- Asset: `dfd1317e-e6ff-41ab-8fec-833c4615add5`.
- Preparation/completed package: `23c55f96-a4f3-4bf7-ad81-5b22b39d2f83`.
- Snapshot SHA-256: `c63e589b4de0c21d8cd50742635b0363764a6eba42c06197ab652602dd13fe5e`.
- Package expiry: `2026-10-14T22:02:00.000Z` (October 14, 6:02 p.m. Eastern).

The normal UI started preparation, checked one private file, and recorded offset
0 through 1 at `2026-10-13T22:02:11.063Z`. The receipt pins 3,961,537 bytes and
SHA-256 `954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b`,
matching the repository audio. Reloading, reopening the draft and using read-only
preparation refresh recovered the same package identity and `1/1` progress
without rerunning the batch. A separate finish completed the package; repeating
the completed-package download preserved the same job. The page shows no graph
warnings and no administrator attestation.

Both normal browser download-event waits timed out; the page reported only
download requested, and no matching package file was found in the standard
Downloads directory. File delivery and local decoding are **not verified** by
this smoke test. The browser policy prevents automated access to its internal
downloads page; no workaround, token extraction or direct database package export
was used. The administrator must click **Download completed package again**, save
that exact package, and personally run/review the pinned validator before any
personal-run confirmation or approval recheck. Ignored screenshot proof is
`frontend/.track-manifests/phase7l-batched-package-check.jpg`.

Read-only D1 checks confirm three drafts, two assets, one preparation/batch and
zero verification passes. Reviews/publications/commits/tracks/versions remain one
each, and public copy receipts remain two; foreign-key checks pass. No new
attestation, public copy or catalog publication occurred. All public-write flags
remain disabled; no Worker/Pages deployment, migration, route, secret or player
change was made for this test. The test draft and audio are retained privately.

In plain English: uploading and preparing the private validation package work,
including recovery after closing/reloading the page. Actual package delivery,
the administrator's own audio check and the new private approval workflow are
still pending. Do not treat preparation as approval or publication permission.

## Report-picker correction and personal validator run

The administrator subsequently downloaded that exact completed package and
personally ran the documented CLI, reporting exit code 0. The ignored local
package/report files match the job and snapshot above. Shared report validation
passes with no errors or graph warnings: Opus, two channels, 48,000 Hz, 8,640,000
samples, 180 seconds and the exact 3,961,537-byte uploaded fingerprint. Report
SHA-256 is `528b255258cb44134e61058f706a50e1ffd61b1dc51e74e0b577a542ebee8067`.
This verifies the downloaded package and reported personal run, not a completed
human attestation or server-side decoding.

Selecting the report in the deployed page exposed an admin-client regression.
The report change handler called `clearReview()` before reading the selected
file. That helper reset the input's `value` to an empty string, which discards a
real browser's selected files. The reader then found no file and left **No
successful report selected.** The earlier automated picker failure had the same
cause; it was not evidence of a file-permission failure or an invalid report.

With the user's approval, the change handler now preserves the newly selected
file while still discarding earlier report authority and both confirmations.
Other resets still empty the picker. The test fixture now models the browser's
file-clearing behavior. A new regression failed against the old code and passes
with the fix; additional cases retain fail-closed behavior for malformed, empty,
oversized, unreadable and cancelled selections. Existing wrong-draft replacement
checks remain in place. No approval or publishing guard was relaxed.

All **537 tests** pass with isolated test-file execution. The first full run had
one local Miniflare `ECONNRESET` in the Wrangler-bundled runtime test; both runtime
tests passed on their focused rerun, then the complete suite passed. All 69
admin-client tests, frontend/Worker lint, normal build and whitespace checks pass.
Normal player outputs remain `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB).

The authorized Worker deployment produced version
`0835138e-1973-4ce9-9423-bdabac62c8ec`, created
`2026-10-13T23:54:22.295604Z`, with message **Fix private report picker with public
writes disabled**. Deployment readback confirms 100% traffic on this version,
unchanged D1/R2/room bindings and the existing secret's presence without reading
its value. All four intent/public-copy/final/publication switches remain false.
No migration, configuration, Pages deployment, route or secret change was made.

The first post-deployment browser reload still received the old script. After
checking the live deployment and refreshing again, the page contained the fixed
handler. Through its normal file picker, the existing report then loaded and
displayed the expected draft/version/job, snapshot, audio measurements and
checksum. The selected filename remained visible. Both confirmations were left
unchecked, and approval/recheck-start buttons stayed disabled; no report was
submitted for approval. Screenshot proof is the ignored
`frontend/.track-manifests/phase7l-report-picker-fixed.jpg`.

Read-only D1 checks confirm unchanged package identity, snapshot and expiry;
three drafts, two assets/jobs, one preparation/batch, one existing review and
zero verification passes. Public publications/commits/tracks/versions remain one
each, with two copy receipts and no foreign-key violations. The public catalog
still contains only the original published test track/version.

In plain English: the app now reads the report instead of accidentally throwing
away the selected file. The administrator's own measurements/warnings review and
explicit confirmation, followed by private batched rechecks/attestation, remain
the next gate. This correction neither approves nor publishes the new draft.

## Completed private batched review (October 13, 2026, Eastern)

The administrator personally reviewed the successful report/graph warnings and
checked the personal-run statement. The agent then used the deployed page to
start verification `04fa0229-4f0a-440f-aa4e-fb44eabcaa84` for the exact existing
draft/package/report above. Starting did not check R2 or approve anything. A
separate manual batch checked the one private audio file, recording offset 0
through 1 at `2026-10-14T00:00:46.000Z`. Reloading/reopening, reselecting the
exact report and using read-only status refresh recovered the same `1/1` result
without replaying the batch. No agent action checked either human confirmation.

The administrator then freshly checked both the personal-run statement and the
distinct batch-window acceptance, and personally clicked **Record batched
administrator attestation (keep private)**. The saved timestamp is
`2026-10-14T00:02:33.830Z` (October 13, 8:02 p.m. Eastern), within five minutes
of the stored check. The saved policy is `gizmagick-local-admin-v1`, scope
`administrator-attested`, and storage-check scope `bounded-batches`.

Read-only D1 inspection confirms the exact verified administrator identity,
job/verification IDs and these immutable review fingerprints:

- Report: `528b255258cb44134e61058f706a50e1ffd61b1dc51e74e0b577a542ebee8067`.
- Snapshot: `c63e589b4de0c21d8cd50742635b0363764a6eba42c06197ab652602dd13fe5e`.
- Manifest: `e4db68e0051ec0097223d2d4a6ad781d88372ecc5c9e6bdd731fab1b25381149`.
- Check interval: both endpoints `1791936046` (`2026-10-14T00:00:46.000Z`).

Reloading/reopening the draft fetched the same attestation. Read-only verification
refresh recovered the historical attested pass and `1/1` progress. Upload,
metadata save, package/report selection, restart/recheck and both approval paths
are locked for this reviewed draft. The page correctly retains **NOT
server-decoded** and the separate-batch limitation; the recorded historical check
is not a claim about storage at some later time or permission to publish.
Ignored screenshots are `phase7l-private-attestation-saved.jpg` and
`phase7l-private-attestation-batches.jpg` under `frontend/.track-manifests/`.

There are now two administrator attestations, one verification pass and one
verification batch. Drafts/assets/jobs remain 3/2/2, with one package preparation
and batch. The original legacy review is unchanged, still `single-request` with
no verification ID or invented batch timestamps. Public publications/commits/
tracks/versions remain one each and copy receipts two; foreign-key checks pass.
The public catalog still exposes only track `32dec11c-96b5-47be-9ffb-76faec7dce8a`
and version `8199557d-6ce1-4d51-8869-1812e1e93f6b`, not the new reviewed draft.
No new public object, catalog entry, upload, deployment, migration, flag, secret,
route or live-player change was made during this attestation verification.

In plain English: the new private workflow is verified from upload through
package preparation, your personal audio validation, fresh stored-file checks,
your separate final approval and recovery after a reload. This cloud walkthrough
uses one real audio file; it does not claim a real 129/256-file cloud test or
automated decoder provenance. The last code checkpoint's 537 passing tests,
lint and unchanged normal build remain the implementation evidence; this is a
documentation-only verification checkpoint, not a new test-suite run.

Next: review a controlled rollout of bounded publication-intent preparation for
this exact reviewed draft. Preparation/reservation do not copy audio; enabling
or testing public copies and final catalog publication requires separate explicit
authorization. Do not reuse or alter the already-published legacy test, enable
public writes automatically, or cut over the live player as part of this private
checkpoint. Original-library import/mapping, the known BleepBloop UglyOnPurpose
timing issue, deployed pinned-room checks and live frontend cutover remain later
gates.
