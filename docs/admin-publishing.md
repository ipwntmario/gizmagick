# Phase 7B: local new-track publishing backend

Implemented on October 12, 2026. **Local tests only; not deployed or enabled on
Cloudflare.** No production migration, public copy, catalog import, or live-player
change was performed. The separate [Phase 7A preflight](admin-publication.md)
remains deployed and read-only.

This increment implements the server protocol and durable audit/retry rules.
There are **no publishing controls in the admin page yet**. Do not enable cloud
publication before the explicit public-exposure confirmation UI and a separately
reviewed rollout. The existing isolated admin-page preview stays private-only.

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

The final boolean must represent explicit administrator approval in the future
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
disposed afterward; this is not a cloud publication or UI walkthrough.

All **303 tests**, frontend/Worker lint, the normal frontend build and Git
whitespace checks pass. The player bundle filenames and sizes are unchanged.
User `.gitignore` edits and ignored browser/generated artifacts are excluded
from this implementation checkpoint.

Next: administrator confirmation/progress UI and isolated browser testing, then
a separately reviewed cloud migration/deployment with publishing still disabled
until an explicitly approved harmless publication walkthrough. Large-track
batching, original library ownership/compatibility mapping, measured import,
range/CORS/playback tests and frontend cutover remain separate steps. The existing
BleepBloop UglyOnPurpose endpoint issue is not changed by this publisher.
