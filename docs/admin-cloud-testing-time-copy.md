# Phase 7Y: Testing Time copy-only rollout

The administrator authorized proceeding with public copying of the verified
[Testing Time reserved plan](admin-cloud-testing-time-planning.md). Local rollout
verification and deployment readback pass; actual public copies remain pending.
Only this plan's 129 audio files and final manifest are authorized here.

## Plain-English rundown and scope

Temporarily enable copying, then use the admin page to copy one confirmed file
per click. Each copied file immediately becomes downloadable by URL. The track
stays unlisted until a later final-verification/catalog-publication step. After
all objects are verified, disable shared/copy writes again. Disabling copying
or archiving does not retract files that are already public.

No automatic multi-file copier, catalog publication, review replacement,
application-code change, migration, secret, Access-policy/route/bucket change or
frontend deployment is part of this rollout. Do not operate on Lena's Home or
either smoke test. Live playback retains its existing source.

## Exact plan and temporary settings

- Original key: `Testing Time`.
- Track: `7031282b-1a1f-5b39-ba9e-1415052d3aad`.
- Draft: `608a370e-6b78-421c-848c-cf23250d1857`.
- Version: `d70d3a75-3bad-4928-a46e-2b6fcadda464`.
- Intent: `c87594da-7b9e-4c3c-a114-463308ad9fde`.
- Plan SHA-256: `5c935e50cde046cf013fe847708740b0f82dcb7ee1ad9e5c7a3054899a77e4c1`.
- Review SHA-256: `3586075fc23c3f4a92bc85be8ba1e57b6f95654395c7846bd006a3f5e740fdfe`.
- Source SHA-256: `468875621bfdccb9c349bd1867aa1863ccc4f3512171a3c759f861aff5b21036`.

The existing plan contains 129 audio objects totaling 21,700,676 bytes and a
75,591-byte final manifest with SHA-256
`89f36dc70ae4bf8d482cf335b636250ac8ad95a38691876efd4eec8b392704c9`.
All 130 unique destinations use the original's fixed track/version prefix.
Its actual approval scope remains `bounded-batches`; readiness/approval audits
are not modified when copying. Review-package/readiness-preparation expiry does
not expire the saved intent. Each copy independently verifies current authority,
the exact private source and its public destination.

| Gate | Temporary value |
| --- | --- |
| Original workflow/intents | `true` (unchanged) |
| `GIZMAGICK_PUBLICATION_ENABLED` | `true` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `true` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` |

These are global workflow switches for eligible administrator-owned drafts, not
a server-enforced Testing Time allowlist. This walkthrough is restricted to the
exact intent above. Both catalog publishers must remain disabled throughout.

## Preflight and local verification

Read-only preflight confirms the exact pending intent at 0/130 receipts, zero
commits, private visibility and no current-version pointer. Review/source hashes,
scope and owner mapping match. Three existing tracks remain public and
foreign-key checks pass. No new cloud data was written by preflight.

The added real-audio Testing Time scenario uses its bounded approval after
package expiry and the actual rollout flags. It exercises 130 single-object
copies, exact retries, status recovery at 16/129/130, manifest-last ordering,
blocked catalog paths, unchanged private files/source/review/plan, and read-only
130/130 recovery after closing fixture gates. The historical original final test
now explicitly uses closed/final-enabled isolated fixtures rather than asserting
the old production mode; the new Testing Time scenario guards actual deployment.
All 635 tests and eight focused rollout tests pass. Frontend/Worker lint and the
normal player build pass; player output remains `index-FinxNOWL.css` and
`index-CQBPIrW7.js`.

## Administrator walkthrough after deployment verification

1. Reload/sign in and open the existing **Testing Time** draft.
2. Click **Refresh intent status (read only)**. Verify the exact intent above and
   its recorded count, initially 0/130. Do not create another plan.
3. Check **I authorize copying the next object...**, then click **Copy one object
   publicly** once. Wait for the response; expect 1/130.
4. Repeat the checkbox/button sequence for each remaining object until 130/130.
   Audio is copied first; the manifest is object 130. Each click confirms only
   the next object. No operation runs automatically.
5. Stop and report the saved progress or supply a screenshot.

There is no five-minute copy deadline. Pausing is allowed; after reload/sign-in,
refresh the exact intent and continue from saved progress. If a request fails,
refresh status before deciding whether to retry: bytes may already be public
even without a receipt. Exact-ordinal recovery cannot copy the following file.

Then verify all public bytes/checksums against the plan, all 130 receipts,
unchanged approval/source/plan and existing catalog, and close shared/copy writes
again. Final catalog publication needs later fresh checks and confirmation.

## Deployed checkpoint

Worker version `1fb51339-2c47-4bfb-8e32-8a99dce6e9a4`, created
`2026-10-31T03:34:57.97723Z` (October 30, 11:34 p.m. Eastern), serves 100% of
traffic. Readback matches all 18 configured variables with shared/copy true and
final/legacy false. D1, both R2 buckets and the room namespace retain their
existing bindings; the administrator-secret binding is present without reading
its value. Post-deployment checks confirm the exact plan/version still pending
at 0/130 with zero commits, private visibility and no current version. Three
public tracks remain, and foreign-key checks pass. The exact three catalog
ID/version pairs were independently verified before deployment.

No files were copied by deployment. The administrator's signed-in copy actions,
all-object verification and closing shared/copy writes remain next. When closing,
adapt the actual-configuration guard to require both switches false before
enabling them only in the isolated copy scenario; retain its guard assertions.
