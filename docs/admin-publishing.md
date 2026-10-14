# Phases 7B–7E: gated new-track publishing

Implemented and tested locally on October 12, 2026, then deployed to the existing
Cloudflare Worker in Phase 7D with **publishing explicitly disabled**. Migration
0004 is applied to the existing D1 database. Phase 7E subsequently completed one
explicitly authorized Lena's Home cloud publication and disabled new writes again.
Its public objects and catalog entry remain public. No original-library import or
live-player cutover was performed. The separate
[Phase 7A preflight](admin-publication.md) remains enabled and read-only.

Phase 7B implements the server protocol and durable audit/retry rules. Phase 7C
adds the administrator confirmation/progress UI and an isolated browser walkthrough
on October 12, 2026. Phase 7D deploys both behind the disabled publishing flag;
the publishing controls are intentionally hidden until an authorized enablement.
The default isolated admin-page preview stays private-only; its explicit
`--publication` mode is a temporary local simulator, not a cloud rollout.

## Administrator controls (Phase 7C)

The page renders publishing controls only when the server's complete effective
publishing capability is enabled, including distinct public/private buckets.
Opening a draft reads its owned publication status. It copies nothing. Unknown
status locks every publishing write; archived, unreviewed, incomplete, oversized
or unsaved drafts cannot start or continue publication.

For a new intent:

1. Use **Check readiness (read only)** to inspect exact track/version, public
   destinations, sizes, checksums and graph warnings. This is a point-in-time
   check, not authorization or a guarantee that later checks will pass.
2. Check the explicit public-exposure confirmation and choose **Create
   publication intent (no copies yet)**. The server rechecks the exact recorded
   snapshot/report; the page sends no client-supplied candidate or object keys.
3. Confirm again and choose **Copy next file publicly** for each file. Progress
   counts durable verification receipts, not bytes in flight. Audio is copied
   first and the manifest last. A failed request can expose bytes without a receipt.
4. After all receipts exist, confirm again and choose **Verify copies and publish
   to catalog**. This separate action verifies every object and performs the
   atomic catalog commit. The page then displays completion time and locks all
   further publishing actions. Private-draft archival does not unpublish it.

Confirmation is never persisted and resets on opening/reopening, refresh,
metadata edits, each action and request failure. There are no automatic POST
retries, polling writes, background progression or stored browser credentials.
Double-clicks cannot send concurrent steps. Private audio uploads are also locked
after attestation, rather than offering replacement of reviewed bytes.

After an interrupted start or copy, use **Refresh publication status (read only)**
before deciding what to do. Failed status reads leave writes locked. A surviving
intent resumes by its recorded ID and progress, without a new preflight (already
copied destinations would legitimately conflict with a new-track preflight).
If a failed start left no intent, rerun readiness before reconfirming; the same
in-memory request UUID is reused in that page session. Reloading loses that UUID
but first reads authoritative status, never automatically starts a replacement.
All server identity, review, lease and conditional-copy protections still apply.

## Isolated browser simulator

From `frontend`, with the existing locked dependencies installed:

```sh
node scripts/gizmagick-admin-preview.mjs --publication
```

Open the printed `127.0.0.1` URL. The visible **LOCAL PUBLICATION SIMULATOR** notice
identifies the synthetic Access identity and temporary local D1/private/public
R2. The harness seeds a new sample derived from Lena's Home, uploads its actual
Ogg locally, runs the pinned decoder and records a synthetic test attestation
through the normal guarded APIs. It creates no publication intent or public
catalog entry until the UI actions above. It never uses production credentials,
remote/configuration flags or Cloudflare storage. Do not tunnel or deploy it.

Reloading the browser retains simulator data; stopping the process discards it.
The simulator's public-media API serves only committed catalog versions. It is
not a real R2 custom domain and does not prove Internet exposure, range/CORS,
cache behavior or production Access login. The synthetic attestation is a test
fixture, never evidence that a real administrator reviewed a production track.

## Scope and limits

- Verified administrator publishing their own attested **new-track** draft only.
- At most **16 audio assets**, each within the existing 16 MiB intake limit;
  publication inputs are at most 2 KiB and the immutable audit plan at most 1 MiB.
- One audio/manifest object per step; a separate final step verifies and commits.
- No ordinary-user publication, ownership transfer, imported/legacy identity
  mapping, replacement audio, published revisions, deletion or cache recall.
- Validation remains **administrator-attested**, never server-decoded.

The 16-asset cap is a conservative initial implementation bound, not a claim that
Cloudflare permits only 16 files. A synthetic 16-file fixture stays below 50
counted storage/database operations per invocation. This is not a production CPU,
latency or cost guarantee. [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/)
also distinguish internal-service subrequests from other subrequests. Testing
Time's 129 audio assets need a later batched inspection/verification design;
increasing the cap alone is not the planned large-track rollout.

## Explicit authorization and endpoints

All endpoints use the existing signed Access identity, administrator allowlist,
owner lookup, exact Origin/CSRF write gate, private/no-store headers and no public
CORS. Caller-supplied identities, manifests, paths, policies, ownership and trust
flags are never accepted by the publisher.

`POST /api/admin/drafts/:id/publication` starts an intent:

```json
{
  "requestId": "<fresh UUID, retained for this intent's retries>",
  "expectedSnapshotSha256": "<the exact recorded review checksum>",
  "expectedReportSha256": "<the exact recorded report checksum>",
  "publicationConfirmed": true
}
```

Start rechecks the exact historical review, reconstructed candidate and private
snapshot, refuses reserved library identities and any existing destination, and
records a unique immutable intent. It copies **nothing**. Same-request retries
return the existing intent; a different request/review conflicts. Each draft and
track identity can have only one intent. Intent creation is guarded against
archival and changes to the exact stored review/job documents.

`GET /api/admin/drafts/:id/publication` (also HEAD) reads owned status: intent ID,
track/version, state, copied/total object counts, next action, timestamps and plan
checksum. No intent returns `publication: null`. It never resumes a job.

`POST /api/admin/drafts/:id/publication-step` advances one step:

```json
{
  "publicationId": "<the server's publication UUID>",
  "publicationConfirmed": true
}
```

The final boolean must represent explicit administrator approval in the
UI, **not** selection of a report or a preflight result. Every step requires it.
No background queue, automatic status-poll progression, browser credential
extraction, or automatic retry loop is included. A status GET, HEAD, unrelated
POST, disabled flag or failed validation cannot publish anything.

## Public-exposure boundary

**Audio becomes publicly reachable by its exact R2 URL as soon as it is copied,
before the catalog commit.** The manifest is copied last. R2 and D1 are not one
transaction. Disconnecting, archiving, disabling the feature or failing the final
commit does not delete copied files or invalidate caches. The API deliberately
reports `publicExposurePossible: true` even before a receipt exists: an interrupted
PUT might have succeeded without its response being recorded.

Never use a real confidential track for a cloud walkthrough. A separate explicit
approval must name the draft/audio and explain this exposure before any cloud
start/step request. The retained private Lena's Home smoke-test draft has **not**
been authorized for publication by implementing or testing this feature.

## Copy, recovery and fencing

Migration `0004_gizmagick_publications.sql` adds three tables:

- `admin_publications`: immutable owner/request/track/version, exact review plan
  and checksum; pending/published state and a temporary two-minute step lease.
- `admin_publication_objects`: immutable ordinal/ETag verification receipts.
- `admin_publication_commits`: immutable final completion timestamp and lease
  fencing token, inserted together with the library publication.

Each step acquires a conditional lease. Competing requests return 409; an
interrupted worker's lease expires after two minutes. A new worker can resume the
same intent, but the old token cannot record progress or commit. Normal success
or failure releases only its own pending lease. Published intents are sealed.

Before each step, the server reconstructs the full current private review and
compares the entire immutable plan, including media base and exact metadata.
Audio reads use the reviewed ETag condition. R2 receives the reviewed SHA-256
with the streamed write, so it checks received-byte integrity without buffering
whole tracks in Worker memory. Destination writes are conditional create-only;
no overwrites or deletes are present. These semantics are documented in the
[R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

A copied object must have the planned size, native SHA-256, custom checksum,
content type/cache policy, publication ID and plan checksum. A lost PUT response
or receipt is recoverable **only** for an object marked with this exact durable
intent and matching native checksum. Identical bytes from an unrelated object
are a conflict. Existing receipts also pin the public ETag at final verification.
No manifest supplied by the browser or prior preflight response is used to copy.

Receipts record verified copies, not every failed request or a complete attempt
timeline. Missing/changed objects after a receipt fail closed; there is no repair,
abandon/restart, cleanup, or unpublish endpoint in this increment. Private files,
reviews, intents, and potentially public partial copies are retained.

## Atomic catalog publication

After all receipts exist, the next step rechecks every public object's metadata,
native checksum, intent markers and recorded ETag, plus the exact private review.
Then one guarded SQLite INSERT and its migration triggers:

1. Check the current lease, active owned draft, exact metadata/review/job,
   allocations, receipts and unreserved library identity.
2. Insert the library track and immutable published version.
3. Set public visibility and the current version pointer.
4. Record the immutable commit and seal the publication intent.

All four happen in the same database statement transaction. A failed guard or
later trigger/constraint rolls back library rows, pointers and completion audit
together. Publication uses the UUID catalog key (`legacy_key` stays null); it
does not infer compatibility mapping from a title. Subsequent requests return
the recorded completion without re-copying or allocating another version.
Archiving the private draft after publication is **not** unpublishing.

The application never overwrites published objects. A privileged out-of-band R2
change between the last HEAD and D1 commit still cannot be made atomic with D1;
bucket administration must preserve immutable published keys. Remote CORS/range,
cache behavior, performance and two-client pinned-room playback are not proven
by local runtime tests.

## Rollout and verification

`worker/wrangler.toml` records `GIZMAGICK_PUBLICATION_ENABLED = "false"`. Publishing
also requires read-only preflight, uploads, reviews and distinct public/private
buckets. Disabled requests return 503 without reading migration 0004's tables;
existing intake/review/preflight remain usable without that migration. There are
no new dependencies, resources, bindings, secrets, Access policies or routes.

Focused tests cover explicit/bounded inputs, identity/owner/admin isolation,
disabled configuration without the new tables, stale reviews, object collisions,
stream checksums, conditional reads, lost responses, leases and old-worker fencing,
archive/review/job/allocation/identity races, ETag/checksum/type/intent changes,
SQL-trigger rollback and immutable audit/history. Both actual Vite- and
Wrangler-bundled Workers publish real Lena's Home bytes into **temporary local**
R2/D1, serve the resulting public version, exercise real trigger rollback and
retry, and enforce signed-token/Origin/CSRF gates. All simulated resources are
disposed afterward; this is not a cloud publication.

Phase 7C browser testing in Brave verified read-only opening/readiness, intent
creation with zero copies, the first real local audio copy, reload/reopen at
**1/2** receipts with unchecked confirmation and no automatic write, the manifest
copy, separate final catalog publication and persisted locked completion. Brave
blocked direct browser navigation to the simulator's catalog API; a read-only
local HTTP check verified the resulting UUID-keyed catalog entry. No browser
security settings were changed. Proof screenshots are ignored local artifacts.

Client tests additionally cover explicit confirmations, lost start/copy responses,
session expiry, same-request recovery, failed status/readiness, malformed or
wrong-version replies, concurrent-click suppression, draft switching, pending
archived exposure warnings, unsaved metadata and server-gated visibility. The
serialized browser script initializes correctly from both actual bundle formats.

All **325 tests**, frontend/Worker lint, the normal frontend build and Git
whitespace checks pass. The player bundle filenames and sizes are unchanged.
User `.gitignore` edits and ignored browser/generated artifacts are excluded
from this implementation checkpoint.

The first authorized cloud walkthrough and single-track delivery/playback checks
are now completed in Phase 7E below. Direct disabled-endpoint browser verification
remains outstanding because Brave blocked navigation. Next: large-track batching,
original-library ownership/compatibility mapping, measured import, deployed
two-client room checks and frontend cutover. Further public copies still require
explicit authorization. The existing
BleepBloop UglyOnPurpose endpoint issue is not changed by this publisher.

## Phase 7D: Cloudflare rollout with publishing disabled

Performed October 12, 2026. Prechecks verified the existing Worker deployment
`ab1461f4-92e3-4f92-9475-d6f7d946571a`, the configured D1 ID
`bb2ac5dd-05af-4e2f-8a4b-51120fac5da4`, unchanged draft/review data, an empty
public catalog and only migration 0004 pending. All 325 tests passed again,
including both actual packaged Workers, and a deployment dry run showed the
correct resources and the publishing flag set to `"false"`.

Read-only R2 checks confirmed:

- `gizmagick-drafts`: no custom domains; public `r2.dev` access disabled.
- `gizmagick-media`: `media.gizmagick.com` enabled, ownership and TLS active;
  public `r2.dev` access still disabled. No domain, CORS or bucket changes made.

A read-only [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
bookmark was retrieved before the migration:
`0000001d-00000000-00005102-a23f23e0e09f5ff57517dac585ba5319`.
This is a recovery reference, not a credential or a database export. No restore
was performed. Do not restore automatically: restoring could discard subsequent
legitimate changes and would require explicit administrator approval.

Applied the committed [D1 migration](https://developers.cloudflare.com/d1/reference/migrations/)
using the existing named database and project configuration:

```sh
./frontend/node_modules/.bin/wrangler d1 migrations apply gizmagick-library --remote --config worker/wrangler.toml
```

Cloudflare reported migration 0004 successful. Postchecks found its three tables
and eleven triggers, no pending migrations, and zero intents, receipts or commits.
The same active draft, archived draft, one uploaded-asset allocation and one
immutable review remained; the existing review hashes and approval timestamp
were unchanged. The library still had zero tracks and versions. The migration
does not move music files or approve/publish drafts.

Deployed the tested Worker with `GIZMAGICK_PUBLICATION_ENABLED = "false"`:

- Active Worker version: `d7ba4277-bdee-43fc-b0a7-827607896da6`, serving 100%.
- D1 and both R2 binding identities preserved; `ROOM_HUB` namespace remains
  `2cde201793224f49bf522d2e8adf4910` and migration tag `v1` is unchanged.
- The existing administrator allowlist secret remains present; no secret values
  were read, uploaded or committed. Existing private intake/review/metadata and
  read-only preflight flags remain enabled.
- No new route, custom domain, Access policy, dependency or Pages deployment.

Post-deployment checks returned 200 for Worker health, the empty public catalog,
the existing media setup-check object and the live site. Anonymous `/admin` and
the retained draft's publication-status endpoint redirected to Cloudflare Access,
not to private data. Read-only HEAD checks for the exact proposed public manifest
and Lena's Home audio returned 404. A final D1 read still found zero publishing
and library records. Pages production remains `main` at `076a5cc`.

Using the computer-use skill, Brave loaded the signed-in admin page and reopened
`Lena's Home (private upload check)` without writes. It displayed **Private drafts
only**, **NOT published**, zero missing files and the unchanged attestation;
publishing controls were absent as expected. A fresh separate session-capability
navigation initially reached Cloudflare's login screen; authentication was not
automated. After the administrator signed in, the displayed session JSON confirmed
`authenticated: true`, the administrator role, enabled uploads/reviews/metadata/
publication-preflight capabilities, and **`publishing: false`**.

Direct GET navigation to the retained draft's `/publication` status endpoint was
blocked by Brave (`ERR_BLOCKED_BY_CLIENT`), including one normal reload. Browser
protections were left unchanged. The server's disabled handler returns
`PUBLICATION_DISABLED` with status 503 and is covered by automated tests, but that
signed-in cloud response was **not observed**. It remains an outstanding browser
verification item, along with the prior archived-preflight check.

Returning to `/admin` and reopening the retained draft again showed its title,
3,961,537-byte uploaded Ogg, zero missing files, **NOT published**, the original
attestation timestamp/hash and no publishing controls. An ignored local screenshot
records this view. A subsequent read-only D1 check confirmed one active draft,
one archived draft, one asset, the unchanged immutable review, and **zero** intents,
receipts, commits, library tracks or versions. No start/step request was sent.

The retained private smoke-test draft is still **not authorized for public copying**.
Before enabling publication,
ask permission naming that draft, its 3,961,537-byte Ogg and public manifest,
`media.gizmagick.com`, the pre-catalog exposure/partial-copy risk, and the fact
that archival does not undo publication. Enabling the flag and testing cloud
copy/final commit are a separate checkpoint; the production player stays legacy.

If this disabled rollout needs a Worker rollback, the previous version is recorded
above. Keep publishing disabled and retain the additive migration/audit tables;
do not drop tables, restore D1 or delete partial/public objects as an assumed
rollback. No rollback was needed during this rollout.

## Phase 7E: first authorized cloud publication

Performed October 12, 2026 local time (October 13 UTC). The administrator explicitly
authorized enabling publishing and publishing **Lena's Home (private upload check)**
as the first test, including its 3,961,537-byte Ogg and public manifest on
`media.gizmagick.com`, pre-catalog/partial-copy exposure and no archival undo.
This authorization did not cover other drafts, the original library or frontend
cutover. Before proceeding, the existing disabled deployment, unchanged review,
zero publishing records and empty catalog were checked again.

All 325 tests passed before temporary enablement. No migration, bucket/CORS/domain,
Access, secret, route or Pages changes were needed. Worker deployments:

- Temporary enabled version: `12e565b4-d179-4b4f-a1b8-c64770aaee53`.
- Writes disabled after completion: `9efe732f-5885-4d4d-99a7-7bb8454a8769`.
- Final tested status-label correction, still disabled:
  `21c87bbd-cba3-4cb9-8b1a-1e106cae28a1`.

Using the computer-use skill, the existing signed-in Brave admin page showed the
enabled controls and the exact reviewed destinations. Readiness passed with no
graph warnings. Explicit confirmation preceded each individual action:

1. Recorded intent `2ef4c3be-eeb6-4df3-af81-d8affdc5ddff` with **0/2** receipts.
   Public HEADs returned 404 and the catalog remained empty.
2. Copied the Ogg, recording **1/2** receipts. Reload/reopen preserved the same
   intent/progress, cleared confirmation and performed no automatic copy.
3. Copied the manifest, recording **2/2** receipts. Both canonical public GETs
   returned the exact reviewed bytes/checksums; the catalog was still empty.
4. Separately verified all copies and committed the catalog entry at
   **`2026-10-13T00:34:35.894Z`**. Reload/reopen showed **Published**, **2/2** verified
   copies, unchecked/disabled confirmation and **Already published** locked.

Final D1 verification found one published intent, two immutable object receipts,
one completion record, one public track and one published version with its current
pointer. A final read after disabling writes confirmed those counts, the same
active/archived drafts, one private asset and unchanged review. Anonymous admin
and private-asset HEADs still redirected to Access (302). IDs:

- Draft: `cc8e145a-1baf-43c1-aa26-b4d2782a6886`.
- Track: `32dec11c-96b5-47be-9ffb-76faec7dce8a`.
- Version: `8199557d-6ce1-4d51-8869-1812e1e93f6b`.
- Immutable plan SHA-256:
  `061d0bf02c1770fa018c29c3ff1f2ebd3db8b6eb8e4f5c22d0d6de3581a648ae`.

Public objects under
`tracks/32dec11c-96b5-47be-9ffb-76faec7dce8a/versions/8199557d-6ce1-4d51-8869-1812e1e93f6b/`:

| Object | Bytes | SHA-256 |
| --- | ---: | --- |
| `audio/Lena's Home.ogg` | 3,961,537 | `954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b` |
| `manifest.json` | 765 | `eafaa0339c986cb7bb385ecd0b7a33fbce222d727f365589501cf267d573e461` |

The title retains its test suffix, and the catalog key is the new UUID with no
legacy-name mapping. The existing review hashes/approval time and private source
files were unchanged; no re-attestation, metadata change or archival occurred.

Read-only public checks after disabling writes passed:

- Catalog and exact pinned-version reads returned 200 with matching identity and
  media URLs; catalog caching remains `no-store`.
- Both canonical public GETs matched length/hash and immutable one-year cache
  metadata. Audio was served from cache (`HIT`); JSON was `DYNAMIC`.
- Both files' HEADs allowed each of the six configured site/local origins, used
  `Vary: Origin`, and exposed the configured ETag/range headers.
- `Range: bytes=0-63` returned 206, exactly 64 bytes and
  `Content-Range: bytes 0-63/3961537`. `Accept-Ranges` was absent on that response;
  it was not required to establish the observed successful range operation.
- Range preflight returned 204 with `GET, HEAD` (no upload methods). An unlisted
  origin received no media CORS allowance; the catalog rejected it with 403.
  This does not restrict non-browser downloads of public objects.
- Worker health and the live site returned 200. Pages production is still
  deployment `2435ec44-d022-4c7b-b40a-92f4bef6e3da`, `main` at `076a5cc`.

An early canonical audio HEAD briefly returned 404 after its receipt; later
canonical HEAD/GETs returned 200 without a purge or storage rewrite. A fresh
diagnostic query also returned 200. This is consistent with
[R2 custom-domain negative caching](https://developers.cloudflare.com/r2/reference/consistency/),
but the precise cause of the early response was not independently proved. No
cache/security settings were changed. JSON responses included a charset and
JSON HEADs omitted Content-Length; decoded GET length/hash checks
remain the source of exact-byte verification.

For actual browser playback, a temporary Vite remote-source preview at
`http://127.0.0.1:5180/` used terminal-only overrides for the cloud catalog and
media base. It displayed one track, loaded the R2 audio, advanced past one minute
with **PLAYING** status and paused successfully. This checks the existing player
against real public storage; it is not a production Pages deployment or a
two-client online-room test. The preview was stopped afterward.

New publishing writes were disabled again before finishing. Source review exposed
a disabled-mode labeling bug: without a status read, the client unconditionally
said **NOT published** and implied all files were private. Commit `7c66f4e`
replaces that claim with **Publication status not checked** and a warning that
existing public copies remain public. The server's disabled status endpoint still
fails closed, controls remain absent and no status query/write is added. Regression
coverage includes previously pending and published drafts. The corrected labels
were verified on the deployed page. A final direct session-page navigation/reload
was blocked by Brave; fresh session JSON and a cloud disabled-endpoint 503 were
not observed in this checkpoint. The final version's configuration confirms
`GIZMAGICK_PUBLICATION_ENABLED = "false"`; no browser protections were changed.

All **326 tests**, frontend/Worker lint, the normal frontend build and Git
whitespace checks pass. Player bundle names/sizes remain `index-FinxNOWL.css`
(250.25 kB) and `index-CQBPIrW7.js` (387.48 kB). Browser proof and the one-off
read-only delivery checker are ignored local artifacts, excluded from commits
along with the administrator's `.gitignore` edit.

Phase 7F implements the [bounded private inspection foundation](admin-storage-inspection.md)
locally, with no cloud deployment or writes. It is read-only and does not change
review-package generation, preflight or the publisher's 16-file limit. A completed
inspection pass is not authorization to publish.

Phase 7G implements [durable batched review packaging](admin-review-packages.md)
locally. Migration 0005 and its enable flag are not applied/enabled in Cloudflare.
Package preparation still grants no approval or publication permission; the
existing full approval recheck and 16-file publisher limit remain intact.

Phase 7H implements [bounded administrator approval rechecks](admin-review-verification.md)
locally. Migration 0006 and its flag are not applied/enabled in Cloudflare. The
new audit distinguishes recent separate-batch checks from the legacy single-request
path; the current preflight/publisher and UI explicitly reject this review type
until a later bounded publisher supports it. Publishing remains disabled.

Phase 7I implements [bounded readiness and version-2 intent reservation](admin-publication-intents.md)
locally. Migration 0007 and its separate flag are not applied/enabled in Cloudflare.
It explicitly retains/rechecks the Phase 7H audit scope but makes no public copies
or catalog changes. Database fences and the legacy publisher prevent version-2
continuation until conditional copying and fresh final verification exist.

Phase 7J implements [one-object conditional copying](admin-bounded-copy.md)
locally, with migration 0008 and a separate disabled flag. Confirmed actions copy
only their exact object position, stream unchanged reviewed audio without
overwriting destinations, and recover exact intent-marked copies after interrupted
responses. In plain English, files can be moved safely one at a time, but they
cannot yet be listed in the catalog through this workflow. The final database
commit fence remains in place. All 488 tests pass; no cloud migration, Worker
deployment, public copy or live player change occurred at this checkpoint.

Phase 7K completes [bounded final verification and atomic catalog publication](admin-publication-final.md)
locally with migration 0009 and another disabled flag. At most 16 private/public
objects are checked per manual batch; all batches must be recent at a separately
confirmed commit. The audit retains the separate-batch, non-atomic storage scope.
The catalog/version/pointer/commit transaction rolls back together on failure,
and interrupted commits recover by reading locked published status. All 530 tests
pass, including actual bundled Worker/local storage checks. No remote migration,
Worker deployment, cloud publication or live frontend change occurred.

Phase 7L completes the [private-only Cloudflare rollout](admin-cloud-batched-rollout.md).
Migrations 0005–0009 are applied; private package/recheck flags are enabled in the
deployed Worker, while intent/public-copy/final/publication switches remain off.
The migration syntax fix preserves all guards. Signed-in read-only checks passed,
and the existing catalog/audio/review/commit records are unchanged. All 531 tests
pass. No new draft, private review, upload or publication occurred.

The subsequently authorized fresh private draft now verifies upload, batched
package preparation and reload recovery, but browser file delivery could not be
confirmed. See the [private smoke-test record](admin-cloud-batched-rollout.md#authorized-private-package-smoke-test-october-13-2026).
That preparation checkpoint added no approval or public write. The subsequent
[completed private-review walkthrough](admin-cloud-batched-rollout.md#completed-private-batched-review-october-13-2026-eastern)
now verifies the administrator's manual package download/personal validator run,
one fresh private recheck batch, explicit human attestation and reload recovery.
The original legacy review/public test is unchanged, and public writing stays off.

Phase 7M now [deploys intent-only plan preparation](admin-cloud-intents-rollout.md)
with public copying/final publication still disabled. The fresh reviewed draft's
two-object readiness batch and reload recovery pass. The administrator then
separately confirmed immutable reservation after renewed recent checks; the exact
version-2 plan persists across reload with `0/2` public copies recorded and locked
continuation. No new public file/catalog entry was created. Anonymous HEAD checks
for its planned audio and manifest return 404; the original public test is unchanged.

Next: review the controlled public-copy rollout and separately authorize any
actual public-copy/catalog-publication test before enabling those write flags.
Reservation itself grants no public-copy permission. Then review original
library ownership/legacy mapping and measured import. Keep the known BleepBloop
UglyOnPurpose timing failure visible. Deployed two-client pinned-room verification
and explicit live frontend cutover remain separate gates. Do not delete this
public test, restore D1 or archive it as an assumed rollback; those actions were
not authorized by this test.
