# Phase 6A: Gizmagick private draft intake

Implemented and tested locally on October 6, 2026. **Not deployed.** This is the
first upload increment, not the whole publication/editor phase. Production
uploads remain disabled: the existing Wrangler configuration has neither a
`GIZMAGICK_DRAFTS` binding nor the upload-enable flag. No cloud bucket was created,
remote migration applied, music imported, or live frontend changed by this work.
The Phase 5 guide describes the previously deployed authentication foundation;
this document describes its new, locally implemented extension.

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

## Next Cloudflare setup — separate rollout

After committing this local implementation, the next resource is a **separate
private** R2 bucket named `gizmagick-drafts`, in the same account. Choose Automatic
location and Standard storage. Keep it empty and confirm in Settings that there
are **no custom domains** and **Public Development URL / r2.dev is disabled**.
Do not add CORS, public access, S3 keys, music, or dashboard Worker bindings.
New buckets are private by default, but both public delivery settings must still
be reviewed. [Cloudflare bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/),
[public access settings](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Only after confirming the bucket is private will we record these changes in
`worker/wrangler.toml` as a separate reviewed configuration checkpoint:

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

Before separately authorized remote changes, inspect the actual D1 schema and
migration history. The recorded remote state is uninitialized: both
`0001_gizmagick_library.sql` and `0002_gizmagick_drafts.sql` would be needed, not
just the second migration. Review/apply version-controlled migrations before
enabling uploads. Preserve the existing room namespace, Access secret/policies,
dashboard-only legacy route, and public-player configuration.

Then separately review/deploy and smoke-test real Access login, private draft
creation/upload/resumption, denied/anonymous access, and public health/rooms.
Do not switch Pages, publish drafts, bulk-import the music library, or delete
legacy files during this rollout. R2 retained private bytes/operations share the
account's usage allowances and can incur charges; archival does not stop storage
charges. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Following increments: trusted audio decoding/duration probing; metadata editing;
reviewed ownership mapping, immutable publication and audit records; staged
library import and frontend cutover. The visual graph editor and ordinary-user
identity/moderation remain later work.

## Git checkpoints on the feature branch

Do not stage secrets, `.dev.vars`, generated audio/import artifacts, or preview
screenshots. Review the staged diff before each commit. No Git staging, commit,
or push was performed by the agent.

1. **Completed Phase 5 deployment/configuration checkpoint**: stage only
   `README.md`, `docs/admin-authentication.md`, `docs/cloudflare-library.md`, and
   `worker/wrangler.toml`. Suggested message:
   `Configure and verify Gizmagick admin authentication`.
   These four pre-existing pending files were left unchanged by Phase 6A work.
2. **Completed local Phase 6A intake checkpoint**: stage `docs/admin-drafts.md`,
   `shared/legacy-manifest.js`, `frontend/eslint.config.js`,
   `frontend/scripts/lib/track-manifests.mjs`,
   `frontend/scripts/gizmagick-admin-preview.mjs`,
   `frontend/tests/adminDrafts.test.mjs`, `frontend/tests/adminRuntime.test.mjs`,
   `worker/package.json`, `worker/migrations/0002_gizmagick_drafts.sql`,
   `worker/src/admin.js`, `worker/src/admin-client.js`,
   `worker/src/admin-drafts.js`, `worker/src/admin-page.js`, and
   `worker/src/generated/manifest-validator.js`.
   Suggested message: `Add private Gizmagick draft upload intake`.
3. The future private binding/migration/deployment verification is another
   checkpoint after cloud setup, not part of either commit above.

Push each completed checkpoint to your current feature branch to back it up;
keep the merge into main for the completed, verified overall migration. A push
is not permission to cut the live player over. If any CI/hosting integration
auto-deploys feature branches, review that behavior before pushing: private
intake must stay disabled until its storage/schema are ready.
