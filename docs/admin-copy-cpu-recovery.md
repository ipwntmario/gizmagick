# Testing Time copy interruption: confirmed CPU limit

Testing Time's [Phase 7Y copying](admin-cloud-testing-time-copy.md) stopped again
at 70/130 after the earlier recovered interruption at 34/130. Read-only checks
confirmed contiguous receipts 0–69, the unchanged pending plan, an unlocked
lease and zero catalog commits. The next file is `audio/PostQ3and4_4.ogg`.

## Confirmed diagnosis

A brief sanitized Worker tail captured the administrator's explicitly requested
retry of object 71 at epoch milliseconds `1793419003170`:

- HTTP 503; outcome `exceededCpu`.
- Exception: `Worker exceeded CPU time limit.`
- Reported CPU time: 31 ms; wall time: 172 ms.

This is evidence of a Worker processing limit, not HTTP 429 click-rate limiting
or an expired Access session. The earlier successful object-35 retry reported
90 ms CPU. The previous interruption was not captured and cannot retroactively
be assigned the same cause with certainty. Repeated similar interruptions make
that plausible, not proven.

[Cloudflare's CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
list 10 ms per request on Workers Free and explain that occasional overruns have
some flexibility but sustained overruns can be terminated. Local functional
tests do not prove compliance with the cloud CPU budget.

The admin client previously labeled every redirected or non-JSON response as a
possibly expired session. That hid the distinction between authentication,
request limiting and resource failures. No Cloudflare policy, rate limit,
subscription or CPU setting was changed to diagnose this.

## Reducing repeated processing

An isolate-local cache now reuses deterministic calculations for exactly
matching JSON text: manifest validation, review-document reconstruction, plan
assembly/checksums, stored-plan parsing/checksum and original-source checksum.
Keys contain the complete text and all relevant context, not just an ID or a
client-supplied hash. Different metadata, review text, source text, context or
media base forces recalculation. Results are deeply frozen, exceptions are not
cached, and eviction safely falls back to recomputation.

The cache holds at most 12 entries and 2,097,152 key characters.
It does not store authentication decisions, current database results,
leases, storage results, public-copy progress or publication permission. Each
request still reads and checks current ownership/status, approval/audit evidence,
file allocations and original identity; each copy retains its source/destination
checks, conditional storage operations and SQL guards. The reserved plan/audit,
private files, copy order and separate confirmations stay unchanged.

Cold starts or eviction still require full calculation. Warm and cold cloud CPU
measurements are needed before claiming the remaining free-plan rollout reliable.
No paid service or weakened validation is introduced by this optimization.

## Clearer browser errors

The client now identifies HTTP 429 separately and displays a numeric Retry-After
delay when provided. Redirects/401 retain sign-in guidance; other non-JSON
responses show the HTTP status and a bounded Cloudflare request reference rather
than assuming session expiry. No HTML response content, cookies or tokens are
shown. All failure paths still clear confirmation, require a status refresh and
never automatically retry a public write.

Requests include Cloudflare's documented
[`X-Requested-With: XMLHttpRequest` header](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax)
so an expired Access AJAX session can return 401 instead of a login redirect.
This does not bypass Access or change the application's JWT/origin checks.

All 643 regression tests pass against the final optimization, including bundled
Worker checks and the 99 browser-client tests with new 429/503/401/403 recovery
cases. Thirteen focused real-audio/security scenarios also passed against the
initial calculation-cache change. Frontend/Worker lint passes; normal player
output remains `index-FinxNOWL.css` and `index-CQBPIrW7.js`. Additional tests cover
exact text/context invalidation, immutable results, failed calculations, bounded
eviction and oversized keys.

Deployment must preserve Phase 7Y shared/copy enablement and both disabled catalog
publishers. After verified deployment, the administrator should reload, refresh
the existing intent and explicitly retry object 71 while a sanitized listener
measures CPU. Do not recreate the plan, reupload, alter timestamps or use direct
database/storage writes to bypass the app. All remaining public copies and their
eventual verification/closure remain within the existing authorized plan.

## Deployment and live measurement

Worker version `fff3f51e-a800-4dac-b3c3-35f204965993`, created
`2026-10-31T04:03:28.640544Z` (October 31, 12:03 a.m. Eastern), serves 100% of
traffic. Readback matches all 18 existing variables and D1/R2/room bindings; the
administrator-secret binding is present without reading its value. Shared/copy
stay true, final/legacy false. No migration or configuration change was needed.
Post-deployment D1 checks confirm 70 receipts, the unchanged plan/review/scope,
private/no-current-version state and zero commits, with three existing public
tracks and no foreign-key violations. Deployment copied nothing.

The administrator reloaded and explicitly resumed copying under sanitized CPU
observation. Eight copies succeeded, bringing persisted progress to 78/130. The
first observed copy used 69 ms CPU; subsequent copies used 31, 31, 30, 32, 34,
36 and 33 ms. All eight returned HTTP 200 without exceptions. A subsequent
request returned HTTP 401 with 3 ms CPU, and the administrator reported the new
sign-in notice with a Cloudflare request reference. That latest interruption is
an authentication rejection, distinct from the earlier confirmed CPU failure.

The listener was stopped. Read-only D1 checks confirm 78 receipts, last ordinal
77, with the last receipt at `2026-10-31T04:06:05.046Z`. The cache reduces repeated
calculation but does **not** bring warm copies under the free 10 ms CPU budget;
it must not be described as a completed free-plan fix.

The administrator chose to keep Workers Free and redesign the copy steps to do
less work per request, rather than enabling Workers Paid. No subscription change
was made. That follow-up should avoid repeatedly transferring/reconstructing the
entire immutable plan inside the Worker, while retaining current database
authority/lease fences, exact source/destination checks, ordinal-specific retries
and separate confirmations. Preserve the existing plan and all 78 receipts.

## Compact copy requests checked inside D1

The free-plan follow-up moves current-record comparisons into SQLite instead of
transferring and reconstructing the complete plan, review and working manifest
inside the Worker for every click. It is opt-in via
`GIZMAGICK_COMPACT_PUBLIC_COPY_ENABLED`, in addition to the existing copy gates.
Both catalog publishers remain disabled for this rollout.

The full metadata, report and graph are still validated when approved and when
the plan is reserved. The existing database retains identical plan text/hash in
both the preparation and intent, with triggers preventing later changes. Compact
copying checks those independent retained copies still match, and fails closed
if the required immutability/identity guards are absent. It does not accept a
new plan or checksum from the browser as proof of approval, and does not merely
trust a remembered authorization decision. The trusted D1 records remain the
authority; an administrator maliciously dropping/recreating database guards is
outside the application's access model.

Each copy freshly compares current draft status/owner, exact review/job text and
fingerprints, original mapping, all asset allocations, and bounded review audit
evidence against that retained plan in D1. The original pinned-source checksum
is independently checked as before. Lease checks repeat current authority inside
D1 before public writes and before receipt recording. Existing conditional source
GET, native checksum on public PUT, destination ownership/ETag verification and
receipt triggers are unchanged. Exact retries still acknowledge only their own
ordinal; copying the manifest early is rejected. No new tables or migrations are
needed, and existing reservations/receipts are adopted without rewriting them.

Status and copy routing now load only the draft identity fields; preparation
and other metadata-dependent operations deliberately reload full draft data.
The Worker receives only the selected file descriptor/source and small status
records for ordinary copies, plus the original-source document for its retained
independent checksum check. Only the final manifest copy loads its candidate
JSON. Full plan/report/snapshot/working-manifest transfer is prohibited by the
real Testing Time test, and its copy SQL bindings are limited to 512 bytes each.

The local 130-object real-audio copy/retry/resume test passes against this path.
Backend tests and both actual bundled Worker fixtures now opt into compact
copying where the required schema is installed; missing-schema cases retain
the earlier explicit compatibility path. Additional cases reject missing intent
protection, mismatched retained plan text and invalid bounded-approval timestamps,
and verify the previous copy path remains available when explicitly disabled.
All 647 tests pass, including both bundled Worker checks, existing mutation/race
and conditional-storage tests running against compact copying, the real 130-file
payload-budget test, and the four new guard/retention/compatibility cases. Lint
passes. No frontend playback code changed; the normal player build remains the
previously verified output.

Compact-copy Worker version `04c5ba19-6216-4c3b-9d33-606e561ff5e8`, created
`2026-10-31T04:25:04.95683Z` (October 31, 12:25 a.m. Eastern), serves 100% of
traffic. The first deployment attempt hit a transient DNS lookup failure; an
identical authorized retry succeeded. Readback verifies all 19 configured
variables (including the new compact flag), unchanged D1/R2/room bindings and the
existing administrator-secret binding without reading its value. Shared/copy
remain enabled, final/legacy disabled. D1 confirms the same 78 receipts,
unchanged plan/review/scope, private track with no current version and zero
commits. Three catalog entries remain public and foreign-key checks pass.
The administrator reloaded, resumed the same saved intent and confirmed reaching
83/130. The sanitized listener captured five HTTP 200 copies, all outcome `ok`
without exceptions. The first used 15 ms CPU; the subsequent four used 10, 9, 10
and 9 ms, versus the earlier 30–36 ms warm samples. The listener was stopped.
These observations support continuing the current free-plan walkthrough; they
do not prove that every future cold start or differently sized track will stay
under 10 ms. In particular, the first observed request still exceeded that
nominal allowance and succeeded under Cloudflare's documented flexibility.

Independent D1 checks confirm 83 contiguous receipts (ordinals 0–82), last saved
at `2026-10-31T04:30:54.519Z`, unchanged plan SHA-256, pending intent, private
track with no current version and zero catalog commits. Foreign-key checks pass.
There was no new plan, reupload, review change or direct database/storage write.
The remaining 47 objects can continue with the existing per-object confirmation;
complete byte/receipt verification and closing shared/copy writes remain pending.
