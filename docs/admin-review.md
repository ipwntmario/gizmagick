# Phase 6D: private local administrator review

Implemented and tested locally. **Not deployed or enabled in cloud.** The live
private intake, public catalog, player, and stored smoke-test draft are unchanged.
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

`worker/wrangler.toml` explicitly keeps `GIZMAGICK_DRAFT_REVIEWS_ENABLED = "false"`.
With it disabled, existing intake works without migration 0003, review endpoints
return 503, and no review tables are queried. The local preview enables the flag
only after applying all three migrations to ephemeral storage.

Before cloud rollout, review/apply migration 0003 remotely, inspect its result,
enable the flag in version-controlled config, deploy the existing Worker while
preserving bindings/room namespace/secrets, and verify real signed-in review of
the retained private Lena's Home smoke-test draft. No new service or signing
secret is required. Keep publication, library import and frontend cutover out of
that rollout. Do not claim a production review until the administrator has
actually performed/confirmed its local run. Real browser sign-out and
denied-account checks from the earlier intake phase remain pending.

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

Next checkpoint: cloud rollout and real admin review verification, then reviewed
metadata editing/ownership and immutable publication. Ordinary-user identity,
moderation, audited cleanup/retention, and the visual graph editor remain later
work. Commit this implementation with
`feat: add private administrator audio review` and push only the feature branch.
