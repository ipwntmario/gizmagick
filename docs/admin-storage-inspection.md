# Phase 7F: bounded private storage inspection foundation

Implemented and tested locally. **Not deployed to Cloudflare in this checkpoint.**
No migrations, bindings, secrets, public objects or catalog rows were changed.
`GIZMAGICK_PUBLICATION_ENABLED` remains `"false"` in the project configuration.
This is the first large-track increment, not completion of large-track publishing.

## Administrator workflow

Open an active draft with every referenced file uploaded and its metadata saved.
Expand **Inspect private storage in small batches**, then click **Check next private
batch (read only)**. Each click checks at most 16 files. Progress and file results
are kept only in memory; reopening, uploading, editing or saving resets the pass.
There is no automatic loop, retry, upload, decoding, attestation or publication.
An error clears earlier results and stops continuation. Reopen the current draft
and restart after correcting the problem or signing in again.

Testing Time's 129-file structure takes nine batches; the existing 256-file intake
limit takes sixteen. These are application batch sizes, not service billing caps.
The tests use Testing Time's actual graph and paths with tiny identification-only
test files, not its real audio or decoder evidence. They do not create a cloud
Testing Time draft or authorize its publication.

## Read-only contract

`GET /api/admin/drafts/:id/storage-inspection?offset=0` starts a pass.
Subsequent requests use offsets 16, 32, etc. and the returned
`snapshot=<allocationSha256>`. `HEAD` runs the same bounded checks but returns no
body. Other methods return 405 with `Allow: GET, HEAD`.

The existing verified Access administrator and owner gates apply. Responses use
`private, no-store` and no public CORS allowance. Unknown or repeated query fields,
malformed offsets/checksums, missing continuation pins and out-of-range offsets
are rejected. The service verifies canonical metadata, complete D1 allocations,
and any declared fingerprints before reading R2. Selected private objects must
have matching byte lengths, native SHA-256, custom SHA-256 and a nonempty ETag.
Metadata/allocations are read again afterward to detect changes during the batch.

A successful request performs at most 16 private R2 HEADs and four D1 queries.
No audio GET, object PUT, public-bucket operation or database write is performed.
The response identifies the exact draft/track/version and manifest checksum,
includes only the selected asset results and the next offset, and explicitly says:

- `scope: "private-storage-batch"`
- `checksPassed: true`, `batchOnly: true`, `pointInTimeOnly: true`
- `audioProbed: false`, `publishing: false`, `publicationAuthorized: false`

The allocation checksum pins metadata and D1 allocation identity across requests.
It is **not** a signed authorization, persisted receipt, review snapshot checksum
or proof that earlier R2 objects remain unchanged. R2 objects in earlier batches
are not rechecked by later batches. There is no atomic all-file snapshot and no
whole-track readiness claim; reaching the final offset is not approval. The
browser checks response identity, ordering, fingerprints and scope against the
loaded draft before advancing its progress.

## Remaining large-track work

The existing review-package generation, attestation and publication preflight
still use their full private-file snapshot checks. This endpoint does not replace
or weaken them. The publisher still refuses drafts with more than **16 audio
files**, even after a successful inspection pass.

Next increments must connect bounded inspection to a durable, exact review
package workflow, preserve stale-data and administrator-provenance guards, and
bound intent/copy/final verification before raising the publisher limit. Inspection
results alone must never unlock those operations. Original-library ownership and
legacy mapping, measured import, cloud rollout, online-room verification and live
frontend cutover remain separate gates. Keep the known BleepBloop UglyOnPurpose
timing failure visible.

## Verification

All **357 tests**, frontend/Worker lint and Git whitespace checks pass. The normal
player build is unchanged: `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB). No browser artifacts or the administrator's
unrelated `.gitignore` edit are included in this checkpoint.

Automated coverage includes 129/256-file batching and exact request bounds,
no database/public/private writes, malformed cursors, owner/admin/Access/origin
gates, missing uploads/objects, checksum/size/ETag mismatches, in-request and
between-request changes, bodyless HEADs, sanitized storage failures, manual
browser-script progression, double-click prevention, invalid replies and reset
behavior. The actual Vite- and Wrangler-bundled Worker executes this endpoint with
real Ogg bytes in temporary Miniflare D1/R2 storage. Its emitted admin script boots
in an isolated browser-like test environment. These are local automated tests;
no real-browser walkthrough or signed-in cloud inspection is claimed here.
