# Phase 7V: original Lena's Home copy-only rollout

Latest follow-up: [Phase 7W](admin-cloud-original-final.md) completes the separately
authorized original catalog publication, with shared/copy/final writes closed
again. The unlisted statements below describe the completed Phase 7V checkpoint.

Completed October 30, 2026, Eastern. The administrator copied both authorized
objects; public bytes and database receipts match. Shared/copy writes are
disabled again, and both catalog publishers stayed disabled throughout.
The original remains unlisted in the cloud catalog; live playback is unchanged.
The deployment/walkthrough sections below preserve the earlier checkpoints.

## Plain-English rundown

The original Lena's Home already has a reviewed, reserved two-file publishing
plan. This step temporarily permits copying its audio and manifest into public
storage. Each file becomes downloadable by URL immediately, but the original
track stays absent from the cloud catalog and the live player is unchanged.
After both files are verified, close shared/copy writes again. Turning copying
off or archiving a draft does not retract public files.

The administrator explicitly authorized these two public copies and temporary
copy enablement. This does not authorize catalog publication, Testing Time,
frontend deployment, another original, or changes to private approval records.

## Configuration and scope

| Flag | Temporary value | Final repository/deployment |
| --- | --- | --- |
| `GIZMAGICK_ORIGINAL_PUBLICATION_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_ENABLED` | `true` | `false` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `true` | `false` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` | `false` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` | `false` |

These are global workflow gates, not a server-enforced Lena's Home allowlist.
Operate only on the exact intent below. No new migrations, secrets, Access
settings, routes or bucket permissions are required. Both catalog paths remain
blocked even while copying is enabled.

## Exact authority

- Original track: `5c22b71c-2af0-5483-8a25-821b726707e1`, key `Lena's Home`.
- Draft: `3cef51f3-d20e-4790-bf8f-df2a1744365b`.
- Version: `0ca37c1b-51ed-4965-9f53-fe9e4292f004`.
- Intent: `926c9038-c0df-4450-b385-6397c47e7850`.
- Plan SHA-256: `9dd42a2d2cb86d7967b2b82bc71f1c597bf18fc36c403dc4e2b9113d9ae96e1a`.
- Review SHA-256: `5a81b6982086930075824b77387b2d0492e61e2335c6ed6c204ad460feb2b767`.
- Original source SHA-256: `17ad6b83aab2617f665b9427d8c9ba672040c198ae7a5d96752b8459d7897e0a`.

Its actual `single-request` review remains unchanged after review-package expiry.
The reserved intent survives readiness-preparation expiry; copying independently
reconstructs authority and verifies the exact source and destination each time.

Destinations under
`tracks/5c22b71c-2af0-5483-8a25-821b726707e1/versions/0ca37c1b-51ed-4965-9f53-fe9e4292f004/`:

| Order | Object | Bytes | SHA-256 |
| --- | --- | --- | --- |
| 0 | `audio/Lena's Home.ogg` | 3,961,537 | `954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b` |
| 1 | `manifest.json` | 721 | `f50d119ecee7304168da247ef0378ade25c58bc48619a4e35b8a561921763573` |

Read-only preflight found this intent pending with 0/2 receipts, zero commits,
private visibility and a null current-version pointer. Testing Time had zero
publication preparations/intents; the catalog still contained only the two
published smoke tests. Foreign-key checks passed.

## Verification and manual walkthrough

All 633 tests pass. Frontend and Worker lint pass, and the normal player build
retains `index-FinxNOWL.css` and `index-CQBPIrW7.js`. The added real-audio test
covers the original's actual review scope after package expiry, both catalog
routes staying blocked, lost successful-copy response recovery, exact-ordinal
retries, unchanged private files/plan/review/provenance, and read-only 2/2 recovery
after closing gates. Historical closed-write scenarios explicitly use closed
local fixtures; a separate assertion guards the actual deployment flag values.

After deployment verification, the administrator should:

1. Reload/sign in to the admin page and open the **original Lena's Home**.
2. Refresh intent status; verify the exact intent above and 0/2 progress.
3. Confirm copying the next object publicly and click **Copy one object publicly**
   once. Expect 1/2, the audio.
4. Confirm again and click once more. Expect 2/2, the manifest. Stop there.

If a request fails, refresh status before choosing a retry. A failed response
does not prove no public file was written. Recovery of an exact ordinal cannot
advance to the next file. Do not create a new plan, archive, publish the catalog,
or touch Testing Time during this walkthrough.

Next, verify public bytes/checksums, both copy receipts, unchanged authority and
catalog, then disable both shared/copy flags and deploy that closed state. Keep
the final and legacy publisher flags false throughout. Final catalog publication
requires its own fresh verification and separate authorization.

## Deployed checkpoint

Worker version `8f45dc0c-1081-4a38-94a5-1c023243a5b3`, created
`2026-10-30T20:11:11.292176Z` (4:11 p.m. Eastern), serves 100% of traffic.
Readback matches all 18 configured variables. D1, both R2 buckets and the room
namespace retain their existing bindings; the administrator secret binding is
present without reading its value.

Post-deployment read-only checks confirm the exact intent/plan/review/version
above, still pending at 0/2 copies and zero commits. The original remains private
with no current version. Testing Time still has zero publishing preparations or
intents. Foreign-key checks pass, and the public API still returns exactly the
two existing smoke-test track/version pairs. No cloud data was written by these
checks. Both public-copy actions, byte/receipt verification and closing the
temporary gates remain next.

## Completed copies and closed-write verification

The administrator confirmed 2/2 progress for the exact intent. Remote read-only
verification found receipts for ordinal 0 at `2026-10-31T00:36:11.341Z` and
ordinal 1 at `2026-10-31T00:36:37.345Z` (October 30, 8:36 p.m. Eastern).
Public GETs returned HTTP 200 and exactly the bytes and SHA-256 values in the
object table above. Their entity tags match the saved receipts (the manifest's
HTTP weak-validator prefix is transport metadata):

- Audio: `1fe9a3fa6dbab0a6495594885deca89b`.
- Manifest: `8285b1afece9d2592927fd3bebe35cc6`.

Shared/copy flags were then set false and deployed as Worker version
`0542215b-7d65-4e4a-9099-99b03b380c7f`, created
`2026-10-31T00:38:24.441925Z` (October 30, 8:38 p.m. Eastern).
Readback verifies 100% traffic, all 18 configured variables, unchanged D1/R2/room
bindings and the existing administrator-secret binding without reading its value.
All four public-writing gates are false.

Post-closure database checks confirm the unchanged intent/plan/version, 2/2
receipts, zero catalog commits, private track visibility and null current-version
pointer. Owner mapping, source version/hash and the original single-request
review/hash match. Testing Time retains zero publication preparations/intents;
the public API still contains exactly the two smoke-test track/version pairs.
Foreign-key checks pass. A transient Cloudflare 7403 read error succeeded on an
identical read-only retry without changing credentials or policy.

The original copy-only test now asserts all four production write gates are
closed before enabling copies solely in its isolated fixture. Six selected
rollout/recovery tests and test-file lint pass after closure; the full 633-test,
frontend/Worker lint and unchanged player build results above precede closure.
No application code changed during this completion step. Authenticated browser
reload verification of closed controls was not automated; deployed flag readback
and persisted 2/2 database progress are verified.

The next separate step is fresh final verification and explicit catalog
publication authorization for this original. No recopy or new intent is needed.
The live-player switch and Testing Time rollout remain separate work.
