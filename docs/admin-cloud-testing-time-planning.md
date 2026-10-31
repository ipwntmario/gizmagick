# Phase 7X: Testing Time readiness and reservation

The administrator requested proceeding with Testing Time's larger publishing
workflow after original Lena's Home publication. This checkpoint verifies private
readiness and guides preparation/reservation of the exact approved plan. Actual
cloud readiness batches and reservation remain pending. Public writes stay off;
no deployment, upload, review replacement or live-player change is needed.

## Verified starting point

- Draft: `608a370e-6b78-421c-848c-cf23250d1857`, status `draft`.
- Original track/key: `7031282b-1a1f-5b39-ba9e-1415052d3aad`, `Testing Time`.
- Private version: `d70d3a75-3bad-4928-a46e-2b6fcadda464`.
- Source version: `79f945fe-8301-5c3d-8266-b9a09ba350d8`.
- Source SHA-256: `468875621bfdccb9c349bd1867aa1863ccc4f3512171a3c759f861aff5b21036`.
- Review SHA-256: `3586075fc23c3f4a92bc85be8ba1e57b6f95654395c7846bd006a3f5e740fdfe`.
- Actual private review scope: `bounded-batches`; verification
  `f69e65a1-30a9-44e0-808e-99e3e7bb9330`.

Read-only D1 checks confirm all 129 manifest assets have uploaded records totaling
21,700,676 bytes, matching administrator ownership and a private library row with
no current version. There are zero Testing Time preparations/intents. Foreign-key
checks pass. The three public catalog entries remain original Lena's Home plus
the two earlier smoke tests. These asset-record checks are not fresh R2 checks;
the signed-in readiness batches below supply those separately.

Active Worker `004ed4a0-4bd2-4239-868a-025b0c85aa68` serves 100% of traffic.
Readback matches all 18 repository variables: original/intents planning is already
enabled, while shared/copy/final/legacy writes are false. No settings need changing.

Four existing focused tests pass, including Testing Time's real decoded audio
through original-aware first publication, 129-asset bounded readiness, planning
with writes closed, and the completed original final workflow's closed production
configuration guard. No new application code or test is added for this walkthrough.

## Administrator walkthrough

1. Reload/sign in and open the existing **Testing Time** private draft. Do not
   import it again or replace its approval.
2. Under **Prepare a bounded publication intent**, click **Refresh intent status
   (read only)**, then **Prepare or resume readiness checks**.
3. Click **Check next readiness batch (no public write)** nine times, allowing
   each response to finish: 16, 32, 48, 64, 80, 96, 112, 128 and 130 of 130.
   The last batch includes the last audio file and the manifest destination.
4. Verify Testing Time's track/version above. Within five minutes of the first
   batch check, read/check the reservation statement and click **Reserve immutable
   intent (no public copies)** once.
5. Stop and report the saved intent ID/status or supply a screenshot.

In plain English, reservation saves a fixed plan for the approved 129 audio
files and one manifest. It does not copy files or add a catalog entry. It is
lasting: archiving does not remove the reservation, and the current workflow
cannot edit that reserved plan in place. Copying and catalog publication still
need their own later checks and confirmations.

All readiness checks must be at most five minutes old at reservation; preparation
expires after 15 minutes. If the page reports stale checks, explicitly restart
readiness and complete the nine batches again. A status refresh does not renew
timestamps. If a request fails, refresh status before deciding whether to retry.

Next verify the saved plan, nine contiguous readiness receipts and exact original
mapping against D1. Public copying remains disabled until the next scoped rollout;
no other draft, existing public object or live-player source changes here.
