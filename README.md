# Gizmagick

A browser-based dynamic music player for tabletop sessions. Tracks can loop, transition between sections, switch musical modes, and synchronize playback across a room.

Live app: [gizmagick.com](https://gizmagick.com).

New to Gizmagick? Read the [user guide and feature wiki](https://github.com/ipwntmario/gizmagick/wiki) for help with playback, sessions, the music library, settings, and more.

Gizmagick's logo assets are in `frontend/public/branding`: `gizmagick-logo-color.png` uses the Dark theme's plum, lavender, indigo (`#725ce0` to `#4939a8`), charcoal, and gold palette with strong rim lighting to improve legibility at small sizes; it is the main app logo, favicon, and touch icon. The previous full-color logo is preserved as `gizmagick-logo-color-original.png`; the earlier Dark theme variants are also kept as selectable Developer logo options. The black and white SVG variants have transparent backgrounds for compact monochrome uses such as notification icons. The live domain and Cloudflare Worker name retain their existing names. Browser storage keys also retain the `wizamp` prefix so existing preferences are preserved.

## Local development

To try the logo variations, open Settings and tap the Settings title five times to reveal Developer options. Use **App logo** to choose the original full-color logo, Dark indigo, Dark gold ribbon, Dark indigo with a gold ring, or either monochrome version. The selection is saved in your browser and updates About, the favicon, and the touch icon.

Use Node.js 22.12+ and npm. From `frontend`:

```sh
npm ci
npm ci --prefix ../worker
npm run dev
```

Open the URL printed by Vite. Choose **Private Session (offline)** for local playback. Playback requires a browser audio-unlock gesture; use Play or Enable audio.

For local online testing, start the actual Worker backend in another terminal from `frontend`:

```sh
npm run dev:worker
```

Set these values in `frontend/.env.local`, then restart Vite:

```dotenv
VITE_ONLINE_MODE=true
VITE_WS_URL=/ws
```

Vite proxies `/ws` to the local Worker on port 8787. The browser uses `ws://` on localhost and `wss://` when the app is opened through HTTPS, including an ngrok tunnel. To test on a phone or away from home, run Vite, the local Worker, and `ngrok http 5173`, then open the ngrok HTTPS URL. The Vite `allowedHosts` list must include your ngrok hostname; update `frontend/vite.config.js` if that hostname changes. If Vite selects another port, pass that port to ngrok instead. Restart Vite after changing `.env.local`.

Open two browser tabs with the same `?room=test-room` URL. Choose Director in one and Member or Observer-Member in the other, unlock audio in both, and select a track. Online Play waits for room readiness. For an already deployed backend, use its `wss://.../ws` address instead. Production builds should continue to set `VITE_WS_URL` to the deployed Worker URL; the `/ws` proxy exists only in the Vite development server.

The `server` folder contains the original presence-only Express prototype. It is retained for reference, but it does not implement playback commands and is not the development backend for the current frontend. Use `dev:worker` instead.

## Checks

Run from `frontend`:

```sh
npm run lint
npm test
npm run build
```

Tests cover room command dispatch and isolation, playback transition/RNG consistency, timer cancellation, buffer-cache cleanup, and catalog sorting. Browser smoke tests are still needed for real audio-device behavior and multi-device timing.

## Code layout

- `frontend/src/App.jsx`: playback UI, track loading, autoplay, and network synchronization coordination.
- `frontend/src/audio/audioEngine.js`: decoded audio buffers, audio nodes, playback and transitions.
- `frontend/src/audio/transitions.js`: shared deterministic next-clip selection.
- `frontend/src/net/useRoom.js`: WebSocket connection, room commands, readiness and clock estimation.
- `frontend/src/net/useSession.js`: room, role, display name, URL and persisted identity.
- `frontend/src/data`: the Gizmagick track repository, catalog loading, and shared track ordering.
- `frontend/src/components`: controls, settings, and the music database.
- `worker/src/index.js`: Cloudflare Worker and room hub.

## Music data

The upcoming R2/D1 migration has a [TrackManifestV2 contract and local tools](docs/track-manifest-v2.md). Phases 1–2 define and validate the combined manifest and convert the existing library. Phase 3 adds a shared repository for catalog loading, playback, queued-track preparation, library duration previews, and Database section/mode previews.

From `frontend`, use `npm run dev:manifest` to test manifest loading, or `npm run build:manifest` to build a static version with the generated Gizmagick catalog and manifests included. Regular `npm run dev` and `npm run build` default to legacy JSON loading for rollback. You can also set `VITE_TRACK_SOURCE=manifest` in the environment or `.env.local`; restart Vite after changing it. Sources are `legacy`, `manifest`, and the opt-in `remote` library preview. In a legacy/manifest online smoke test, run the local Worker and use the same track source in both tabs.

Manifest mode generates validated metadata directly from the original JSON/audio at server startup or build time. It does not require the ignored `.track-manifests` exports. Restart the development server after changing musical data. Browser validation uses the same schema and graph rules; invalid manifests or mismatched catalog/version data report a loading error. Audio is still fetched from the original `public/tracks` paths during this phase. Original music files, browser preference keys, and room message names remain compatible.

For standalone exports, run `npm run tracks:migrate` for a dry run or add `-- --write` to export manifests into the ignored `.track-manifests` directory.

Phase 4 adds the D1 catalog schema, read-only Worker API, and remote repository. The Worker configuration targets the verified existing `gizmagick-worker`, binds `gizmagick-library` and `gizmagick-media`, and preserves `ROOM_HUB`. See the [local D1/R2 setup and rollout guide](docs/cloudflare-library.md). It includes a local-only seed command; production library import/publication and frontend cutover remain pending. Remote online rooms now use [version-pinned synchronization](docs/room-library-protocol.md), including queued tracks and reconnects. Default production loading is unchanged.

Phase 5 adds a fail-closed Cloudflare Access admin guard, a separate Worker-served `/admin` page, and `/api/admin/session`. See the [admin authentication and Cloudflare setup guide](docs/admin-authentication.md). The existing Worker is deployed with admin-only Access and a private email allowlist; the administrator confirmed successful real sign-in and the verified-admin page. Room roles do not grant admin permissions. Install the Worker's locked dependencies with `npm ci --prefix ../worker` from `frontend` before backend development or tests.

Phase 6A implements private new-track intake, and Phase 6B deploys it with the separate, verified-private `gizmagick-drafts` bucket and both D1 migrations. The admin page imports legacy JSON pairs or merged manifests, accepts bounded Ogg uploads, and resumes private drafts. See the [private draft workflow and rollout status](docs/admin-drafts.md). Trusted audio probing and publication remain disabled. The public catalog is now valid but empty; the live player still uses legacy files. Real signed-in cloud creation, audio upload, and resumption after reload are verified with one private Lena's Home test draft. All 171 automated tests pass, including browser-script initialization from the actual Wrangler bundle.

Phase 6C adds a [free local audio-validation runner](docs/audio-validation.md): `npm run tracks:probe -- --track "Lena's Home"` from `frontend` fully decodes Ogg audio and checks measured durations against clip timings. It also supports downloaded canonical draft manifests. Reports are local-only review candidates, not server-trusted approval or publication; no cloud state or source music/data changes occur. The catalog sweep passes 12 of 13 tracks, including all 129 Testing Time assets, and records an existing out-of-bounds endpoint in `BleepBloop UglyOnPurpose` without changing it.

Phase 6D connects that runner to a [private administrator review workflow](docs/admin-review.md): a server-issued draft/file snapshot package, exact local fingerprint and timing checks, and an explicit human provenance confirmation stored as an immutable D1 audit record. It is labeled administrator-attested, never server-decoded; report selection alone grants no approval. All 234 tests pass. Migration 0003 is applied and cloud review is enabled/deployed. Real signed-in package generation, the administrator's personal local run and confirmation, and reload persistence are verified with the private Lena's Home test draft. The browser download delivery itself remains unconfirmed; the walkthrough used an equivalent package saved from its exact D1 job. Publication and live frontend cutover remain pending.

Phase 6E adds a [private draft JSON metadata editor](docs/admin-metadata.md), tested locally and enabled on the existing Worker on October 12, 2026. It validates graph edits, preserves uploaded audio and identity, rejects stale saves, clears outdated review selections, and locks attested/archived drafts. Signed-in cloud save/reload and rejection checks passed on an approved metadata-only test draft, now archived through an explicitly approved guarded maintenance fallback after browser confirmation automation stalled. Lena's Home's original attested draft remains locked and unchanged. This does not edit published tracks, transfer ownership, publish files, or change the live player.

Phase 7A adds a [read-only publication preflight](docs/admin-publication.md), enabled on the existing Worker on October 12, 2026. It reconstructs the exact recorded review, rechecks private object checksums/ETags and proposed public destinations, and refuses reserved identities or object collisions. All 271 tests, lint and build pass; deployment, public endpoints and unchanged cloud records are verified. Signed-in cloud preflight passed for the attested Lena's Home draft, with publishing disabled and no writes. Brave blocked inspection of the archived-preview response; that rejection remains covered by automated tests. The actual publisher, ownership mapping for existing tracks, library import, and player cutover are still separate work.

Phase 7B adds a [local-only new-track publishing backend](docs/admin-publishing.md): explicit confirmation, immutable intent/receipt/completion records, conditional one-object copy steps, interrupted-copy recovery, lease fencing, and a guarded atomic D1 catalog commit after all objects are verified. The first version supports up to 16 audio assets; larger tracks need later batching. It remains disabled in cloud configuration. No production migration, public upload, or live-player change occurred.

Phase 7C adds administrator publishing controls with exact track/version identification, a public-exposure warning, read-only readiness/status checks, fresh confirmation for each copy, receipt progress, safe interruption recovery and a separate final catalog-publication action. All 325 tests pass. The isolated browser simulator (`node scripts/gizmagick-admin-preview.mjs --publication` from `frontend`) verified real local copying, reload/resumption and locked completion; its synthetic sample and storage are temporary. The default preview remains private-only. Cloud rollout and any real public copying still require separate review and explicit authorization.

Phase 7D applies migration 0004 and deploys the tested publisher/UI to the existing Cloudflare Worker with publishing explicitly disabled. All 325 tests pass again. The private bucket remains private, bindings and the admin secret are preserved, the public catalog and publishing tables remain empty, and Pages production still uses main at `076a5cc`. After the administrator signed in, fresh session JSON confirmed the admin role and `publishing: false`; the retained draft remained unpublished with unchanged review data and no publishing controls. Brave blocked direct navigation to the disabled publication-status endpoint, including one normal reload, so its signed-in 503 response remains unverified; no browser protections were changed. Enabling publication still requires explicit public-copy authorization. No public copies or live-player cutover occurred. See the [rollout evidence and remaining authorization gate](docs/admin-publishing.md).

Phase 7E completes the explicitly authorized first cloud publication of **Lena's Home (private upload check)**. Its exact reviewed Ogg and manifest are public, and D1 contains one completed publication, two object receipts and one published track/version. Signed-in creation, individual copies, reload/resumption and locked completion passed; public checksums, six-origin CORS, range requests, pinned-version reads and cloud-backed playback in a local preview passed. New publishing writes were disabled again afterward. The disabled admin page now reports publication status as unchecked instead of incorrectly claiming a previously published draft is private/unpublished. All 326 tests, lint and the unchanged normal player build pass. Pages production still uses main at `076a5cc`; the original library import and live frontend cutover remain pending. See the [first cloud test record and next steps](docs/admin-publishing.md#phase-7e-first-authorized-cloud-publication).

Phase 7F adds a [bounded private storage inspection foundation](docs/admin-storage-inspection.md), tested locally but not yet deployed. The admin page checks up to 16 private files per manual request, pins metadata/allocation identity between batches, clears stale results, and explicitly grants no audio approval or publishing permission. Tests cover Testing Time's 129-file structure and the 256-file draft limit. Review packaging and large-track publishing remain separate increments; the publisher's 16-file limit and disabled cloud publishing configuration are unchanged. No cloud data or live player changes occurred.

Phase 7G adds [resumable batched review packages](docs/admin-review-packages.md), implemented and tested locally with migration 0005 and a disabled-by-default rollout flag. Each manual batch checks at most 16 private files and records durable progress; a separate finish action creates the existing validator-compatible package. Preparation never grants approval or publication, and the original full approval recheck remains intact. Testing Time's 129-file structure and 256-file preparation are covered; the actual bundled Worker and real local validator pass with Lena's Home audio. No cloud migration/deployment, public copy or player change occurred. Bounded approval revalidation and larger-track publishing remain next.

Phase 7H adds [bounded administrator approval rechecks](docs/admin-review-verification.md), tested locally with migration 0006 and a disabled rollout flag. Each manual request rechecks at most 16 private files against an exact locally validated package/report. A separate fresh personal-run and batch-window confirmation records an immutable, distinctly labeled audit; all checks must be at most five minutes old. This is not an atomic storage snapshot or server decoding, and the current publisher/UI reject the new review type until bounded publication supports it. The legacy single-request review remains unchanged. No remote migration, Worker deployment, public upload or live-player change occurred.

Phase 7I adds [bounded readiness and immutable publication intents](docs/admin-publication-intents.md), tested locally with migration 0007 and a disabled rollout flag. It reconstructs the exact administrator-attested plan (including Phase 7H's distinct batch scope), checks up to 16 private sources and 16 public destinations per manual request, and reserves a version-2 intent only after separate confirmation and complete recent checks. All 448 tests pass. No public-copy or catalog-commit path exists for these intents yet; the legacy publisher and database fences reject continuation. No remote migration, Worker deployment, public upload or player change occurred. Conditional copying and independent bounded final verification are next.

Phase 7J adds [one-object conditional public copying](docs/admin-bounded-copy.md), locally tested with migration 0008 and a separate disabled flag. In plain English: each confirmed click copies one unchanged, approved file without overwriting anything; retrying the same object cannot accidentally copy the next file. Testing Time's 129-file graph, 256-file copying, interrupted requests and actual bundled Worker/local storage checks pass. All 488 tests pass. Catalog publication remains locked pending fresh bounded final verification. No remote migration, Worker deployment, cloud copy or player-source change occurred.

Phase 7K adds [independent bounded final checks and atomic catalog publication](docs/admin-publication-final.md), tested locally with migration 0009 and a separate disabled flag. In plain English: freshly check the originals/copies in small groups, then separately confirm adding the exact approved track/version to the catalog. Complete recent checks, current ownership/review/allocations and exact receipts are required; catalog/audit/pointer writes save together or roll back together. The audit preserves the separate-batch trust boundary, and interrupted commits recover through read-only status. All 530 tests pass. The complete bounded new-track publisher is locally ready for rollout review; no remote migration, Worker deployment, cloud publication or live-player cutover occurred.

Phase 7L completes the [private-only Cloudflare rollout](docs/admin-cloud-batched-rollout.md): migrations 0005–0009 are applied and the Worker is deployed with private batched packages/rechecks enabled. In plain English, the private-review tools are now live, while all intent/public-copy/catalog-publication switches remain off. A remote migration guard-syntax incompatibility was fixed without removing safeguards, and an ignored recovery backup was rehearsed locally. All 531 tests pass; signed-in read-only storage checks and unchanged public catalog/audio fingerprints pass. No new draft, upload, approval or publication was created, and the player remains unchanged. A separately authorized fresh private workflow test is next.

The subsequent authorized private smoke test created **Lena's Home (batched review check)**, uploaded its existing Ogg and completed one batched review package through the deployed page. The same `1/1` progress survived a reload and read-only refresh. Database checks confirm no new approvals or public-library records. Browser file delivery could not be confirmed, so the administrator's manual package download, personal validator run and batched approval rechecks remain pending. In plain English: private preparation works; the new approval workflow is not yet cloud-verified. See the [smoke-test record](docs/admin-cloud-batched-rollout.md#authorized-private-package-smoke-test-october-13-2026).

The administrator then downloaded the exact package and personally ran the validator successfully. An admin-client bug cleared the newly selected report file before reading it; the authorized [report-picker correction](docs/admin-cloud-batched-rollout.md#report-picker-correction-and-personal-validator-run) now preserves that file while resetting earlier review authority and confirmations. All 537 tests pass, including browser-like file-selection regressions. The corrected Worker is deployed with public writes still disabled, and the actual admin page accepts the existing report. No new attestation or public-library record was created. Personal review/confirmation and private batched approval verification remain pending.

The subsequent [completed private-review walkthrough](docs/admin-cloud-batched-rollout.md#completed-private-batched-review-october-13-2026-eastern) verifies the administrator's personal review, a fresh private storage recheck, separate human batch-window confirmation and persisted `bounded-batches` attestation. Reload/status recovery and exact audit fingerprints pass; the original legacy review and public catalog remain unchanged. In plain English: the new private upload-to-approval workflow works for this one-file test, but nothing new is public and the live player is unchanged. Controlled publication-intent rollout review is next; real public copies/publication require separate authorization.

Phase 7M [enables publication-plan preparation on Cloudflare](docs/admin-cloud-intents-rollout.md) while keeping public copying and final/legacy publication disabled. All 538 tests pass, including an actual-configuration guard that allows reservation but rejects public-write requests. The new reviewed draft's audio/manifest readiness checks pass (`2/2`). After renewed recent checks, the administrator separately confirmed its immutable version-2 reservation; the exact plan survives a reload with `0/2` public copies recorded and continuation locked. Anonymous HEAD checks for its planned audio and manifest return 404, and the public catalog is unchanged. In plain English: the publishing plan is saved and locked, but nothing new is public. Controlled public copying requires separate authorization; this documentation-only reservation checkpoint does not enable it.

Phase 7N [completes the authorized public-copy rollout](docs/admin-cloud-copy-rollout.md) with a separate fail-closed legacy-publication gate. All 546 tests, lint and the unchanged normal player build pass; nine selected rollout tests also pass after disabling writes again. The administrator authorized this exact reserved test's audio and manifest copies; both now have matching public bytes/receipts and persisted `2/2` progress, including re-sign-in/reload recovery. Both catalog publishers stayed disabled throughout, and shared/copy writes are off again. In plain English: the two files are public by URL, but this test is not listed in the catalog and the live player has not changed. Final verification/catalog publication requires separate authorization; original-library import, track-update conveniences and player cutover remain separate work.

Phase 7O [completes the authorized final catalog-publication rollout](docs/admin-cloud-final-rollout.md). All 549 tests, lint and the unchanged normal build pass; ten targeted rollout tests pass after closing writes again. The exact batched-review test passed fresh private/public checks, separate confirmation, a guarded catalog commit and reload recovery. Its review/plan/copy receipts and both tests' public bytes remain unchanged. Draft-opening messages correctly distinguish bounded workflows from the disabled legacy publisher. In plain English: this one-file test is now listed in the database catalog, with a saved final-check audit; the catalog has two test tracks. New public writes are off again, legacy publishing stayed off and the live player is unchanged. Original-library import, real large-track cloud verification, track-update conveniences and explicit release/cutover remain separate work.

Phase 7P adds a [read-only original-library audit](docs/original-library-import.md), available as `npm run library:audit` from `frontend`. In plain English: inventory the real library, preserve its identities, check each combined manifest against current legacy data/audio, and fully decode the files before building an importer. All 13 source manifests match; 176 assets (56,473,347 audio bytes) decode, with 12 tracks passing and the known `BleepBloop UglyOnPurpose` timing failure left unchanged. The optional owner mapping is a proposal only; cloud conflicts and final versions are not checked/reserved. No upload, deployment, public write or player change occurs. Identity-preserving private intake for originals is the next implementation step, followed by separately authorized import/review/publication and release verification.

Phase 7Q adds [identity-preserving private intake for originals](docs/admin-original-imports.md), tested locally and disabled by a separate flag. In plain English: the original ID/catalog key and authenticated owner are reserved privately together with a fresh-version draft and immutable source record; audio is uploaded separately. Conflicts, quotas and interrupted-request retries cannot overwrite or adopt existing records. The admin form has a separate original-import mode and confirmation; every current publisher rejects these drafts, even with public-write flags on. Migration 0010 is local-only; no cloud import, deployment, publication or player change occurred. The agreed future `clipEnd` rule—default missing/overlong endpoints to measured file duration, retaining shorter trims—is documented for unreviewed metadata preparation, not applied silently here. Original-aware publication support and a separately approved private rollout are next.

Phase 7R adds [bounded first publication for imported originals](docs/admin-original-publication.md), locally tested behind a separate disabled flag and migration 0011. In plain English: publish an original's first reviewed version using its existing private owner/ID/catalog-key reservation, not an unrelated copy or an already-public track. The immutable plan and database fences bind that mapping through preparation, conditional copying and atomic final commit. Real local Lena's Home and Testing Time audio pass end-to-end; both bundled Workers and mapping-aware UI recovery are covered. New-track and legacy safeguards remain intact. No cloud migration, deployment, upload, publication or player-source change occurred; the agreed unreviewed clipEnd preparation rule and separately authorized rollout are next.

`frontend/public/trackData.json` contains a `tracks` object keyed by track name. Each entry names its `basePath`, `firstSection`, `simple` flag, and optional display name/test flag.

Each track folder contains:

- `clipData.json`: a `clips` object. Each clip specifies its audio `file` (a string or a map of mode names to files), `loopStart`, `loopPoint`, `clipEnd` in seconds, and `nextClip` choices.
- `sectionData.json`: a `sections` object defining `firstClip`, available `nextSection` choices, optional `modes`, and section type (`auto` or `end` where applicable).
- `audio/`: audio files referenced by the clip metadata. The base mode is named `base`.

The scripts in `frontend/scripts` support audio import and older metadata migration. `process-clips.mjs` requires FFmpeg/FFprobe and may write metadata or convert audio; review its header before running it. Existing `.bak` metadata files are retained as migration backups. Audio and musical metadata are not modified by code cleanup.

Pins, display-name overrides, volumes, and UI preferences are local to the browser. Identity uses `wizamp.role` and `wizamp.displayName`; the former underscore-separated keys are read as migration fallbacks.
