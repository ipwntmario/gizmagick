# Phase 7W: original Lena's Home final catalog rollout

Authorized and deployed October 30, 2026, Eastern, after the administrator's request
to proceed with final verification and catalog publication after the verified
[two-file copy checkpoint](admin-cloud-original-copy.md). Deployment verification
passes; actual signed-in final checks/publication remain pending.

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

| Flag | Temporary final rollout |
| --- | --- |
| `GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED` | `true` (unchanged) |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` (unchanged) |
| `GIZMAGICK_PUBLICATION_ENABLED` | `true` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `true` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `true` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` |

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
