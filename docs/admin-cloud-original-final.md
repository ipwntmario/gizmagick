# Phase 7W: original Lena's Home final catalog rollout

Completed October 30, 2026, Eastern, after the separately authorized final
workflow following the verified [two-file copy checkpoint](admin-cloud-original-copy.md).
The administrator's screenshot and read-only cloud verification confirm the
original Lena's Home is published to the cloud catalog. Shared/copy/final writes
are disabled again; legacy stayed off throughout. Live playback is unchanged.
The preparation and initial deployment statements below are historical.

## Plain-English rundown

The two files are already public. This step checks the private audio and public
copies again, then lets the administrator confirm adding this exact reviewed
original version to the cloud catalog. Nothing is uploaded again. The live
player retains its existing metadata/audio source; its migration comes later.

The catalog transaction saves the original's first published version, current
version pointer, visibility and publication audit together. A failure rolls those
database changes back together; storage and D1 are not one transaction.

## Exact scope and temporary settings

- Original key/title: `Lena's Home`.
- Track: `5c22b71c-2af0-5483-8a25-821b726707e1`.
- Draft: `3cef51f3-d20e-4790-bf8f-df2a1744365b`.
- Version: `0ca37c1b-51ed-4965-9f53-fe9e4292f004`.
- Intent: `926c9038-c0df-4450-b385-6397c47e7850`.
- Plan SHA-256: `9dd42a2d2cb86d7967b2b82bc71f1c597bf18fc36c403dc4e2b9113d9ae96e1a`.
- Review SHA-256: `5a81b6982086930075824b77387b2d0492e61e2335c6ed6c204ad460feb2b767`.
- Original source SHA-256: `17ad6b83aab2617f665b9427d8c9ba672040c198ae7a5d96752b8459d7897e0a`.

Its actual private review scope remains `single-request`. Final storage checks
have their own `bounded-batches` audit; they do not relabel or replace that review.
Do not create another intent, repeat copying, change Testing Time, or operate on
either similarly named published smoke test.

| Flag | Temporary final rollout | Final repository/deployment |
| --- | --- | --- |
| `GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_ENABLED` | `true` | `false` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `true` | `false` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `true` | `false` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` | `false` |

The final workflow currently depends on the shared and copy gates as well as its
own gate. These flags enable eligible administrator-owned workflows globally;
they are not a server-enforced allowlist for this original. This authorization
and walkthrough cover only the exact intent above. The final gate enables both
checks and the separately confirmed commit endpoint, not a checks-only mode.

Close shared/copy/final gates again after verified publication. Keep legacy off
throughout. No migration, application-code change, secret, Access-policy, route,
bucket-permission or frontend deployment is part of this rollout.

## Read-only readiness and local verification

Preflight confirms the exact pending plan/version, 2/2 saved receipts, zero
commits and zero final passes. The original is private with no current-version
pointer; its source/review fingerprints match. Testing Time has no intent, and
only the two smoke tests are public. Foreign-key checks pass. An initial
Cloudflare 7403 query error resolved with an identical read-only retry.

The new real-audio rollout test uses this original's actual single-request
review scope after package expiry. It asserts the actual repository rollout
flags, recovers two existing copies, forbids R2 reads/writes other than HEADs,
rejects premature or unconfirmed commits, performs one private/two public HEADs,
preserves timestamps on batch retry, publishes once and recovers an exact commit
retry without duplicates. Original source/review/plan/receipts remain unchanged;
closing fixture gates retains the published original catalog key and version.
Historical closed-write and copy-only tests now explicitly configure their
isolated scenarios while the new test guards the current rollout settings.

All 634 regression tests and seven focused rollout tests pass, along with
frontend/Worker lint and the normal player build. Player output remains
`index-FinxNOWL.css` and `index-CQBPIrW7.js`.

## Manual signed-in workflow after deployment verification

1. Reload/sign in and open the **original Lena's Home**.
2. In **Final verification and catalog publication**, click **Refresh final status
   (read only)**. Verify the intent/version above and two recorded copies.
3. Click **Start or resume final verification**.
4. Click **Check next final batch (no catalog change)** once. Expect 2/2 fresh
   object checks; no publication has occurred yet.
5. Within five minutes of checking, read/check the final publication statement
   and click **Confirm publication to catalog** once. This is the actual catalog
   write. It accepts separate recent storage checks and the administrator's
   existing review, not server-side audio decoding or an atomic storage snapshot.
6. Stop and report the resulting status. If a response fails, refresh status
   before considering a retry. Never assume a failed reply means no commit.

If checks become stale, explicitly restart final verification and check again.
Passes expire after 15 minutes. Do not alter timestamps or use direct D1/R2 writes
to replace the authenticated workflow. Browser automation previously encountered
a URL access restriction; the administrator performs authenticated UI operations.

After confirmation, verify the original catalog key, ID/version/pointer/audit,
unchanged review/plan/receipts, both existing smoke entries, Testing Time and
public bytes. Then close shared/copy/final writes, test the closed configuration,
verify deployment and save the feature-branch checkpoint. No live-player switch
is authorized by this catalog-only step.

## Deployed checkpoint

Worker version `16939eea-075b-46dd-8c22-fee0f4e27e8d`, created
`2026-10-31T03:09:15.076568Z` (October 30, 11:09 p.m. Eastern), serves 100% of
traffic. Readback matches all 18 configured variables, including shared/copy/final
true and legacy false. D1, both R2 buckets and the room namespace match the existing
bindings; the administrator secret is present without reading its value.

Post-deployment read-only checks confirm the same pending intent/plan at 2/2,
zero commits and zero final passes. Its track is private with no current version;
Testing Time still has no preparation/intent. Foreign-key checks pass. Public
preflight GETs independently confirmed the exact audio/manifest sizes and hashes
recorded in Phase 7V and the unchanged two smoke-test catalog entries. Deployment
performed no final verification, copy or catalog publication. Manual final checks
and publication, result verification and closing shared/copy/final flags remain
next. The existing final publisher requires those three gates temporarily enabled;
no extra copying is authorized or necessary.

## Completed catalog publication and closed-write verification

The administrator supplied a screenshot showing this exact original, version,
plan and source hash with completed 2/2 final checks and locked published status.
Read-only D1 verification confirms one final pass
`b7f3ebc6-1237-47bb-a336-9cfe68570407`, one batch covering objects 0–2, and one
catalog commit at `2026-10-31T03:13:15.735Z` (October 30, 11:13 p.m. Eastern).
The batch started/finished at `2026-10-31T03:12:48.000Z`, approximately 28 seconds
before publication, within the five-minute requirement. Final audit scope is
`bounded-batches`; the original private review remains `single-request` with its
unchanged report hash. Review/source/plan hashes and owner mapping match.

The original library row is now public/published with its existing compatibility
key `Lena's Home` and current pointer `0ca37c1b-51ed-4965-9f53-fe9e4292f004`.
Exactly one version row and one commit exist for this original. Its two copy
receipts retain their original ETags/timestamps; nothing was recopied. Public
GETs returned the same expected 3,961,537-byte audio and 721-byte manifest with
the Phase 7V SHA-256 values. The public API contains exactly this original plus
the two prior smoke-test ID/version pairs. Testing Time still has zero planning
preparations/intents, and foreign-key checks pass.

Shared/copy/final gates were set false and deployed as Worker version
`004ed4a0-4bd2-4239-868a-025b0c85aa68`, created
`2026-10-31T03:14:17.827934Z` (October 30, 11:14 p.m. Eastern). Readback verifies
100% traffic and all 18 configured variables, unchanged D1/R2/room bindings and
the administrator-secret binding without reading its value. All four public-write
gates are false. Post-closure D1/API checks confirm the published original,
one version/commit, retained 2/2 copies and all three expected catalog entries.

Seven selected rollout/recovery tests and test-file lint pass after closure.
The actual-configuration test now requires all four production write gates false
before enabling finalization only in isolated storage. The full 634-test run,
frontend/Worker lint and unchanged player build above passed before closure.
This completion changes configuration, test expectations and documentation only.
Authenticated post-closure browser reload was not automated; active flags and
persisted published state were independently verified through read-only tools.

No Pages deployment or live-player source change occurred. The next original
rollout can exercise Testing Time's 129 audio files plus manifest, subject to its
own readiness, reservation and public-exposure/publication authorization.
