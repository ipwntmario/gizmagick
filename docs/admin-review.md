# Phase 6D: private local administrator review

Implemented, tested locally, and **deployed with cloud review enabled** on
October 7, 2026. Migration 0003 is applied. Real signed-in package generation,
the administrator's personal local run and confirmation, and persistence after
reload are verified on October 8, 2026. The retained private smoke-test draft
now has one administrator attestation; the public catalog and player are unchanged.
This increment connects the free local validator to a specific uploaded draft;
it does not implement publication, editing, cleanup, or public-user uploads.

## Trust boundary

Local JSON reports are unsigned. Neither a checksum nor a server-issued package
proves that a trusted decoder ran. A report alone cannot approve anything.
The verified administrator must personally run the repository's pinned validator,
inspect its successful measurements and graph warnings, and explicitly confirm
that provenance. The server records that human assertion as
`scope: "administrator-attested"`, with `serverDecoded: false`.

The existing `audioProbed` and `publishing` flags remain false. This must not be
silently relabeled as automated or server-trusted decoding. A future publisher
may support this narrowly trusted admin-only policy explicitly, after rechecking
the exact private bytes and snapshot. Ordinary contributors must never receive
this approval capability. Supporting review of another user's draft will also
need an explicit moderation/ownership design; today administrators can only
review their own new-track drafts.

## Local walkthrough

From `frontend`, start the isolated preview:

```powershell
node scripts/gizmagick-admin-preview.mjs
```

Use its printed loopback `/admin` URL. It has a simulated identity and temporary
D1/R2, not a real production session. Never tunnel or deploy this harness.

1. Create a private draft and upload every referenced Ogg file, as in the
   [private intake guide](admin-drafts.md).
2. Click **Download review package**. Save the package and obtain the exact
   private audio using the draft's download links. Place the files under a
   selected track directory's `audio/` subdirectory with their original names.
   Repository files are usable only if all fingerprints match the uploaded bytes;
   a matching track title is not enough.
3. From `frontend`, run the actual CLI directly so npm's banner cannot contaminate
   the JSON. Substitute your local paths; save the report outside source files:

   ```powershell
   node scripts/gizmagick-audio-probe.mjs --review-package "C:/path/draft-review-package.json" --track-root "C:/path/track" | Set-Content -Encoding utf8 "C:/path/review-report.json"
   $LASTEXITCODE
   ```

   Require exit code **0** and `valid: true`. Errors on stderr or exit code 1 are
   failures, even if PowerShell created an output file. The CLI overwrites no
   files itself; the example's `Set-Content` overwrites the selected report path,
   so choose a new/disposable report filename. UTF-8 output works in Windows
   PowerShell and PowerShell 7.
4. Choose the report in **Local validator report**. Inspect its measurements and
   the draft's graph warnings. Report selection sends no approval request.
5. Check the personal-run confirmation only if it is true, then click
   **Record administrator attestation (keep private)**.
6. Reload/reopen the draft. It retains the approver's opaque identity, timestamp,
   report SHA-256 and snapshot SHA-256. It still says **NOT server-decoded / NOT
   published**. Archiving retains the historical attestation and files, but
   archived drafts cannot receive a new approval.

Existing `--track` and `--manifest` commands still emit `scope: "local-only"`
reports. They are deliberately rejected by this endpoint. Use `--review-package`
for a draft-bound candidate. Packages are not credentials or signing secrets;
the authenticated admin guard is required for every private request.

## Server checks and audit record

The POST-only, owner-scoped `/api/admin/drafts/:id/review-package` endpoint binds
the server's canonical manifest, draft/version IDs, complete uploaded asset set,
private object keys, byte lengths, SHA-256 and R2 ETags into a hashed snapshot.
It requires the R2 native SHA-256 checksum recorded by the existing upload
`put(..., { sha256 })`, not just client metadata. R2 exposes supplied checksums on
stored objects. [Cloudflare's R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
Objects with missing/mismatched checksums fail closed; no re-upload or repair is
performed automatically.

The package expires after 24 hours. Repeating its request reuses the current job
while its snapshot is unchanged and unexpired. An expired/changed package is
replaced, invalidating old reports. Storage is bounded to one job and one accepted
review per draft rather than accumulating unlimited review rows.

POST `/api/admin/drafts/:id/attest-review` requires the policy
`gizmagick-local-admin-v1`, `provenanceConfirmed: true`, and the package-bound
successful report. The server:

- Rechecks verified administrator role, owner, canonical metadata, completeness,
  native R2 fingerprints and ETags before considering confirmation.
- Rejects wrong jobs, stale metadata, partial/extra measurements, unknown trust
  fields, failed results and mismatched decoder versions.
- Checks coherent sample counts, supported codec/channel/rate/overlap limits,
  bounded duration, each exact fingerprint, and any supplied duration constraint.
- Reconstructs an enriched review candidate from its own manifest plus the
  measurements, then reruns canonical graph/timing validation. No submitted
  enriched manifest, clip edits, title changes, ownership or publication flags
  are accepted.
- Records approval in one conditional D1 INSERT that rechecks job identity,
  expiry, ownership, archival, exact manifest and every asset allocation at the
  write. Same-report retries converge on one immutable record; different reports
  conflict. The original draft manifest remains unchanged.

Migration `0003_gizmagick_draft_reviews.sql` adds the pending-job and immutable
review/audit tables. The record stores the verified approver ID, policy, timestamp,
snapshot/manifest/report hashes, report and separately reconstructed candidate.
All APIs retain signed Access authentication, exact admin Origin and CSRF header
for writes, no public CORS permissions, private/no-store responses, and bounded
bodies. Packages allow 512 KiB and reports 256 KiB (plus a bounded request wrapper).
Snapshots retain existing intake graph limits. These are not billing caps.

R2 and D1 do not form a cross-service transaction. The intake path never overwrites
uploaded bytes; external/dashboard changes during approval cannot be made atomic
with the D1 write. This record is historical human review, **not an unconditional
future publication permit**. A publisher must reverify source objects and use
conditional, non-overwriting copies. Do not expose arbitrary R2 mutation or
contributor approval under this policy.

## Rollout and verification

`worker/wrangler.toml` now records `GIZMAGICK_DRAFT_REVIEWS_ENABLED = "true"` after
the reviewed migration/deployment. With the flag disabled, existing intake works
without migration 0003, review endpoints
return 503, and no review tables are queried. The local preview enables the flag
only after applying all three migrations to ephemeral storage.

The cloud rollout applied migration 0003 remotely, inspected its result, enabled
the flag in version-controlled config and deployed the existing Worker while
preserving bindings/room namespace/secrets. Real signed-in review of the retained
private Lena's Home smoke-test draft is now verified (see the October 8 record
below). No new service or signing secret is required. Publication, library import
and frontend cutover are excluded. The administrator personally performed and
confirmed the local run. Real browser sign-out and denied-account checks from
the earlier intake phase remain pending.

Automated tests cover real Lena's Home decoding and the actual CLI against
packages minted by both Vite- and Wrangler-bundled Workers using local D1/R2;
JWT/allowlist/Origin denial, reload/resumption, missing files, fingerprints/ETags,
expired/changed packages, forged/partial measurements, graph timing, concurrent
retries, archival races, and disabled rollout with review tables absent. Browser
script tests cover initialization and deliberate confirmation, including clearing
an earlier valid report when a replacement is invalid. This is automated runtime
verification, not a live browser or cloud walkthrough.

All **234 tests**, frontend/Worker lint, a separate shared-contract lint check,
the normal frontend build and Git whitespace checks pass. Both actual Worker
packaging modes are exercised without deployment. The frontend asset filenames
and sizes match the preceding checkpoint; no local decoder enters the player.
The suite required unrestricted loopback/junction permissions for simulator and
path-escape checks, not production credentials. Windows line-ending comparisons
in the existing validator/secrets-ignore tests were made platform-neutral without
weakening their content checks.

## Cloud rollout record (October 7, 2026)

Read-only preflight confirmed the previously deployed version
`bb261147-f084-4169-b365-5aaf6940bb7b`, only migration 0003 pending, one private
draft/asset, and zero published tracks/versions. The drafts bucket still has no
custom domain and disabled public `r2.dev` access. No security/access policy,
bucket setting, route or domain configuration was changed.

The reviewed additive migration `0003_gizmagick_draft_reviews.sql` applied
successfully; migration listing then showed none pending. Both new review tables
were empty, with unchanged prior draft/asset and library row counts.

All 234 tests, lint, frontend build and whitespace checks passed with the review
flag enabled. The deployment produced Worker version
`89aa58e2-02c4-4e0b-9a9f-d3297060992e`. Deployed metadata confirms the enabled
flag, retained `GIZMAGICK_ADMIN_EMAILS` secret name (value not read), D1
`bb2ac5dd-05af-4e2f-8a4b-51120fac5da4`, both existing media/drafts buckets, and
unchanged `ROOM_HUB` namespace `2cde201793224f49bf522d2e8adf4910`.

Anonymous checks, with redirects disabled and only redirect hostnames recorded:

- `/health`: 200, `{ "ok": true, "worker": "gizmagick-worker" }`.
- `/api/library/catalog`: 200, `{ "schemaVersion": 2, "tracks": {} }`.
- Non-upgrade `/ws`: 426; no new two-client or opening-handshake test was run.
- `/admin` and both review endpoints for the retained smoke-test draft: 302 to
  the configured Access team. No authenticated API/session token was extracted.
- A draft-shaped public media path: 404.

Pages production remains on `main`, source `076a5cc`, deployment
`2435ec44-d022-4c7b-b40a-92f4bef6e3da`. This reflects the separately requested
android-app theme/font merge, not a storage/library cutover. Feature-branch pushes
are previews; this rollout did not deploy Pages or change its environment.

The agent opened the protected admin page in Brave for the administrator. Access
requires a fresh sign-in, so the computer-use skill requires user handoff;
the agent neither entered nor requested an email code. Signed-in package download,
native stored-checksum verification through the deployed handler, report import,
explicit human attestation and reload/resumption remain pending. No new draft,
review job, approval or audio upload was performed by the agent in this rollout.
No library object/row was published or imported.

To disable reviews in a future reviewed deployment, set the review flag to
`"false"`, retaining all tables and private data. The previous Worker version is
a rollback reference, not authorization to reverse migrations or automatically
roll back. Do not remove the new tables or recreate the room namespace.

## Cloud administrator review verification (October 8, 2026, Eastern)

The administrator signed in to the deployed admin page. Its review-package
handler created job `87da610f-1e4f-4277-a702-1e95c9ae326f` for the retained
private Lena's Home draft `cc8e145a-1baf-43c1-aa26-b4d2782a6886`, verifying
native stored R2 checksums and the complete snapshot. The browser reported
download initiation, but its download event/file could not be confirmed. The
agent therefore saved an equivalent package from that exact D1 job into the
ignored local artifacts directory, without changing the job or recording approval.
This verifies server-side package generation, not reliable browser-download delivery.

A local rehearsal passed, and the administrator then personally reran the
documented CLI, selected the report, reviewed the measurements/warnings,
confirmed provenance, and recorded the private attestation. The report is valid
with no errors: one 3,961,537-byte stereo Opus file, 48,000 Hz, 8,640,000 samples,
and 180 seconds, matching the exact private asset fingerprint. Graph warnings
were empty. No agent action substituted for the personal-run confirmation.

The recorded audit timestamp is `2026-10-09T02:36:06.394Z` (October 8 in Eastern
time). Its report SHA-256 is
`159a54dc722c00c5f754b6058dc0aa6f7222312e0cfea8ae4ce7489d1318a6b8` and snapshot
SHA-256 is `d693253b38f314514f111ff7acfce5ed7f068f59f84984b54eef1b9390805c80`.
Reloading the page and reopening the draft fetched the same saved attestation;
the package, report-selection, and attestation controls were disabled. The draft
still explicitly says **NOT audio-probed / NOT server-decoded / NOT published**.

Read-only remote D1 checks confirmed one draft, one uploaded asset, one job, one
`administrator-attested` review under `gizmagick-local-admin-v1`, and zero library
tracks/versions. The initial D1 query received Cloudflare error 7403; after
Wrangler confirmed the expected OAuth account and D1 permission, the retry
succeeded without credential or configuration changes. The public catalog
still returns `{ "schemaVersion": 2, "tracks": {} }`.

This verification made no new draft, upload, publication, deployment, route,
bucket, Access-policy, or frontend change. Local packages/reports stay ignored;
no credentials are included in this checkpoint. Browser sign-out and
denied-account checks remain pending.

Next checkpoint: reviewed metadata editing/ownership and immutable publication.
Ordinary-user identity, moderation, audited cleanup/retention, and the visual graph editor remain later
work. Implementation checkpoint: `15eddc0`,
`feat: add private administrator audio review`. Rollout checkpoint: `6458959`,
`feat: enable private administrator review on Cloudflare`. Push checkpoints only
to the feature branch; main remains reserved for the completed migration.
