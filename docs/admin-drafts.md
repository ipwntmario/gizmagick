# Phases 6A–6B: Gizmagick private draft intake

Implemented/tested locally in Phase 6A and deployed in Phase 6B on October 6,
2026. This is private new-track intake, not the whole publication/editor phase.
The separate `gizmagick-drafts` bucket is verified private, both D1 migrations
are applied, and the Worker has its project-configured draft binding and enable
flag. Production library import, trusted audio probing, publication, and live
frontend cutover remain disabled/pending. **Fresh signed-in cloud upload testing
is pending the administrator's Access login.** See the rollout record below.

## What works

The existing same-origin, Access-protected `/admin` page now supports:

- Creating a **new-track** draft from a schema-v2 merged manifest, or importing
  the existing `clipData.json` and `sectionData.json` pair with a title, first
  section, and simple/test settings. Neither legacy source files nor published
  track identities are modified. This is not an edit-existing-track workflow.
- Server-side structural and graph validation through the canonical contract.
  The shared legacy adapter preserves the existing converter's deterministic
  IDs for migration/export. All 13 legacy tracks, including Testing Time, pass
  intake tests.
- Choosing Ogg files through a file picker or dropping them into the audio area.
  Filenames must exactly match the manifest's expected audio filenames. The
  browser uploads them one at a time; the server chooses private object keys.
- Listing/reopening the signed-in owner's recent drafts, viewing missing files
  and graph warnings, and downloading merged metadata or private uploaded files.
- Archiving a draft to stop uploads. **Archiving retains its files and storage
  allocations.** No delete, cleanup, restore, or replacement-file UI exists yet.

Owners come only from verified Access identities, never submitted JSON. Every
private API operation uses the existing signed-JWT guard; writes additionally
require the exact admin Origin and `X-Gizmagick-Admin-Request: 1`. Public room
roles confer no admin access. Responses are non-cacheable; downloads are served
as attachments, not executable content. No browser token storage is added.

Intake checks the initial Ogg/Opus-or-Vorbis identification header, actual byte
count, and server-computed SHA-256. Any supplied manifest fingerprint is checked
against uploaded bytes. **This is not a decoder, trusted duration probe, or
malware scan.** Uploaded duration metadata is untrusted. Even a malformed file
with a plausible identification header can pass this preliminary check, so
`audioProbed` and `publishing` remain false. No handler writes published library
rows or objects to `gizmagick-media`.

## Limits and safe retries

Intake allows 256 KiB combined request/canonical metadata, 256 assets, 2,048
clips, 128 sections, 16 MiB per audio file, 256 MiB per draft, 512 MiB total audio
allocation per owner, and 20 active drafts. These conservative initial limits
are application checks, **not Cloudflare billing caps** or rate limiting.

Draft creation uses an owner-scoped UUID `requestId` plus the exact request-body
checksum. Retrying the same body returns the same draft; different data with the
same request ID returns a conflict. The page retains its request on a failed
creation attempt until inputs change.

Uploads reserve capacity atomically in D1 before conditional, non-overwriting R2
writes. Pending/interrupted uploads and archived drafts continue to count toward
storage limits. Retrying the same asset bytes reuses the reservation; different
bytes require a new draft. Soft archival frees an active-draft slot, not bytes.
These retained allocations deliberately avoid quota bypass during partial
failures. An explicit, audited cleanup/retention policy is still needed before
opening intake to ordinary contributors. The list shows the latest 100 drafts.

## Local preview and verification

Install frontend and Worker dependencies as described in the authentication
guide. From `frontend`, run:

```sh
node scripts/gizmagick-admin-preview.mjs
```

Open the loopback URL printed by the script. The visible notice says **Local test
preview**. This isolated harness generates ephemeral signing keys and a
synthetic `preview@example.invalid` identity, with temporary D1/private R2 and a
local certificate-server response. The real Worker still verifies the signed
token. It reads no production credentials/config files, accepts no remote flags,
binds only to `127.0.0.1`, and validates the Host header. **Do not expose it through
a tunnel or deploy it.** Stopping the process discards its data; restarting is
not persistence testing for production storage. It is not a production login
bypass or a substitute for checking real Access sign-in after deployment.

For a quick test, import the JSON pair from `frontend/public/tracks/Lena's Home`,
choose `Lena's Home` as the first section, mark **Simple track**, create a draft,
and upload `audio/Lena's Home.ogg`. Reload, then reopen it in **Your recent
drafts**. It should show zero missing files, **NOT audio-probed**, and **NOT
published**. The local browser walkthrough verified this with the existing
3,961,537-byte Ogg; the browser-use skill surfaced the extension's file-access
permission requirement, which the administrator enabled themselves.

Checks from `frontend`:

```sh
npm test
npm run lint
npm run build
```

The tests cover signed authorization in the minified Worker simulator using real
Lena's Home bytes, private R2 writes/downloads, both migrations, owner isolation,
unsafe requests, graph validation, size/type/fingerprint errors, retries,
concurrency, interrupted writes, active-draft/storage quotas, and separation
from public storage/catalog rows. Worker packaging is checked with Wrangler's
`deploy --dry-run`, **not deployment**. The checked-in standalone validator's
freshness is tested against `shared/track-manifest.schema.json`; regenerate it
with the existing `createManifestValidatorSource` helper when that schema changes.

## Cloudflare setup and rollout record

The separately authorized Phase 6B rollout created `gizmagick-drafts` in the same
account using Automatic placement and Standard storage, with no config
auto-update. CLI checks confirmed **no custom domains**, **r2.dev access
disabled**, and **no CORS configuration** (Cloudflare error 10059 means the
configuration does not exist, not a failed authentication check). No S3 keys or
dashboard-only bindings were created. New buckets are private by default, but
both public delivery settings must still be reviewed before enabling intake.
[Cloudflare bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/),
[public access settings](https://developers.cloudflare.com/r2/buckets/public-buckets/).

After those checks, `worker/wrangler.toml` recorded this separate private binding
and the upload flag, without changing the public media binding or routing:

```toml
# Add within the existing [vars] section:
GIZMAGICK_DRAFT_UPLOADS_ENABLED = "true"

# Add a separate top-level R2 binding:
[[r2_buckets]]
binding = "GIZMAGICK_DRAFTS"
bucket_name = "gizmagick-drafts"
```

Never map this binding to `gizmagick-media`. A runtime check rejects the same
binding object being reused, but cannot prove that two separately configured
bindings point to different physical buckets or that dashboard public access
is disabled. The configuration/settings review is essential. No public domain
is needed for private uploads; the guarded Worker accesses R2 directly using its
binding. [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

The remote preflight found only Cloudflare/system migration tables and both
migrations pending. The reviewed `0001_gizmagick_library.sql` and
`0002_gizmagick_drafts.sql` were applied successfully; a subsequent migration
listing shows none pending. Row counts for both library tables and both private
draft tables were zero immediately after deployment, before any upload test.
No catalog rows, ownership mapping, or published media were imported.

All 170 tests, lint, normal frontend build, and Worker dry-run packaging passed.
The authorized Worker deployment produced
`08f5c987-fc73-4355-91a8-1b288f7bf755`. Compared with the previous authentication
deployment `6b283865-049e-4aae-a259-737122a75563`, deployed metadata confirms the
same D1/public R2 resources, retained `GIZMAGICK_ADMIN_EMAILS` secret name, and
unchanged `ROOM_HUB` namespace `2cde201793224f49bf522d2e8adf4910`. The secret value
was not read. The previous Worker version is a rollback reference, not permission
to roll back automatically or reverse migrations. To disable intake in a future
reviewed deployment, set the upload flag to `"false"`; retain private data.
The dashboard also confirms the existing `*.wizamp.app/*` route and enabled
production Worker URL were retained. Its Worker Builds section shows no Git
repository connected; feature-branch pushes do not deploy this Worker.

Anonymous post-deployment checks:

- `/health`: 200, `{ "ok": true, "worker": "gizmagick-worker" }`.
- `/api/library/catalog`: 200, `{ "schemaVersion": 2, "tracks": {} }`.
- Non-upgrade `/ws`: 426. A real unauthenticated WebSocket opened with zero
  room/playback messages sent. The .NET client's closing-handshake wait timed
  out and the client was disposed; this is an opening-handshake check, not a
  verified graceful-close or two-client playback test.
- `/admin`, `/admin/`, `/api/admin/drafts`, and an unknown child draft path:
  302 to the configured Access team. Redirect tokens/query strings were not
  deliberately extracted or recorded.
- A draft-shaped public media path: 404.

The deployed admin browser requested a fresh email-code sign-in. Per the
computer-use skill, the administrator completes authentication themselves;
no code, cookie, or JWT is requested or copied. The administrator separately
authorized one private Lena's Home smoke-test upload (its JSON pair plus
3,961,537-byte Ogg), but it has not been performed while sign-in is pending.
Real signed-in creation/upload/resumption, sign-out, and denied-account browser
checks remain pending. Do not mistake the earlier local simulated login/upload
walkthrough for these production checks.

Pages deployment history confirms `storage-and-database` pushes create previews;
the latest production deployment remains on `main`, source `50bc859`, deployment
`c120359d-12f4-4e46-be4b-0a86a48f63eb`. No Pages deployment/environment/DNS/Access
policy change was performed during this rollout. Production frontend source and
legacy assets remain in place. Do not switch Pages, publish drafts, bulk-import
the music library, or delete legacy files during intake verification. R2 retained
private bytes/operations share the account's allowances and can incur charges;
archival does not stop storage charges.
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Following increments: trusted audio decoding/duration probing; metadata editing;
reviewed ownership mapping, immutable publication and audit records; staged
library import and frontend cutover. The visual graph editor and ordinary-user
identity/moderation remain later work.

## Git checkpoints on the feature branch

Do not stage secrets, `.dev.vars`, generated audio/import artifacts, or preview
screenshots. Review the staged diff before each commit. The administrator
authorized the agent to stage, commit, and push subsequent checkpoints to
`storage-and-database`; main remains untouched until the overall migration is
complete. Do not amend unrelated commits or force-push.

1. **Completed Phase 5 deployment/configuration checkpoint** (`114e770`): included
   `README.md`, `docs/admin-authentication.md`, `docs/cloudflare-library.md`, and
   `worker/wrangler.toml`. Message:
   `Configure and verify Gizmagick admin authentication`.
   These four pending files were left unchanged by Phase 6A implementation.
2. **Completed local Phase 6A intake checkpoint** (`fedb164`): included `docs/admin-drafts.md`,
   `shared/legacy-manifest.js`, `frontend/eslint.config.js`,
   `frontend/scripts/lib/track-manifests.mjs`,
   `frontend/scripts/gizmagick-admin-preview.mjs`,
   `frontend/tests/adminDrafts.test.mjs`, `frontend/tests/adminRuntime.test.mjs`,
   `worker/package.json`, `worker/migrations/0002_gizmagick_drafts.sql`,
   `worker/src/admin.js`, `worker/src/admin-client.js`,
   `worker/src/admin-drafts.js`, `worker/src/admin-page.js`, and
   `worker/src/generated/manifest-validator.js`.
   Message: `Add private Gizmagick draft upload intake`.
3. **Phase 6B cloud configuration/deployment checkpoint**: stage only
   `worker/wrangler.toml`, `README.md`, `docs/admin-drafts.md`,
   `docs/admin-authentication.md`, and `docs/cloudflare-library.md`.
   Suggested message: `Configure Gizmagick private draft storage rollout`.
   Record outstanding real-login/upload checks honestly; their completion can
   be a follow-up verification checkpoint.

Push each completed checkpoint to your current feature branch to back it up;
keep the merge into main for the completed, verified overall migration. A push
is not permission to cut the live player over. If any CI/hosting integration
auto-deploys feature branches, review that behavior before pushing: private
intake must stay disabled until its storage/schema are ready.
