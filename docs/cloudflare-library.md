# Gizmagick library: Phase 4 foundation

The code now supports a D1-backed catalog and versioned R2 manifests/audio. This change was tested with local simulated resources; it does not migrate the remote database, upload music, deploy the Worker, or change the live frontend's track source. Admin login, upload APIs, private drafts, and room version pinning are separate work.

## Resources and schema

`worker/wrangler.toml` now names the **existing** `gizmagick-worker` (the dashboard confirmed it replaced the old name), preserving its `ROOM_HUB` binding and migration. New bindings are `GIZMAGICK_DB` → `gizmagick-library` (ID `bb2ac5dd-05af-4e2f-8a4b-51120fac5da4`) and `GIZMAGICK_MEDIA` → `gizmagick-media`. Resource IDs are configuration, not credentials. Existing browser storage keys remain unchanged.

The first version-controlled D1 migration creates:

- `library_tracks`: stable ID, nullable unique legacy compatibility key, opaque owner ID, visibility, lifecycle status, current-version pointer, timestamps.
- `library_track_versions`: composite track/version identity, staged/published status, canonical manifest key and SHA-256, schema version and display/playback metadata.

A composite foreign key prevents a pointer from selecting another track's version. A trigger prevents updates to published version metadata. The API selects only public published tracks with published versions. The compatibility key remains the original name for imported tracks; new tracks can use their UUID as the UI key without relying on unique titles. Ownership/status are controlled by storage, never accepted from a manifest.

Published objects use `tracks/{trackId}/versions/{versionId}/manifest.json` and `audio/{filename}.ogg`. The default public media base is `https://media.gizmagick.com`. This bucket is public: database visibility filters and CORS cannot make its objects private or revoke copies already downloaded. Drafts and unapproved uploads must use separate private storage. Do not put credentials or private documents in this bucket.

## Read interfaces

| Route | Result |
| --- | --- |
| `GET /api/library/catalog` | `{schemaVersion: 2, tracks: {[compatibilityKeyOrId]: entry}}` |
| `GET /api/library/tracks/{trackId}/versions/{versionId}` | One published version entry, including historical versions of a currently public/published track |
| `GET /api/library/media/tracks/{trackId}/versions/{versionId}/manifest.json` | R2 manifest, useful for local testing |
| `GET /api/library/media/tracks/{trackId}/versions/{versionId}/audio/{filename}.ogg` | R2 audio, useful for local testing |

Entries contain `id`, `versionId`, `manifestUrl`, `basePath`, `defaultDisplayName`, `firstSection`, `simple`, and `test`. Owner/draft information is never returned. Catalog and version-entry responses use `no-store`; immutable media uses a one-year cache policy. The media route reads complete objects (current Web Audio playback downloads whole files); partial-range streaming is not implemented. Production catalogs point directly to the media custom domain instead of routing audio through the Worker.

`HEAD` and read-only `OPTIONS` are supported; mutations return 405. Private/staged/archived/unknown versions return 404. Missing bindings or schema/storage failures return sanitized 503 errors. API CORS uses `GIZMAGICK_APP_ORIGINS`, allows no credentials, and does not substitute for authentication. The existing `/health` and `/ws` behavior stays separate from library routing.

The browser validates schema and graph rules, checks catalog/manifest metadata agreement, and requires media URLs to exactly match the configured base and track/version IDs. Errors never trigger silent legacy fallback. Repository metadata caches remain keyed by source, track and version; failed requests can be retried.

## Local setup

Use Node.js 22.12+; schema tests use Node's built-in SQLite API (currently marked experimental). Run from `frontend`. Stop your local Worker before migrations/seeding, so concurrent processes do not race on storage.

```sh
npm ci
npm run library:migrate:local
npm run library:seed:local
```

The seed command accepts **no arguments or remote flag**. It reads the validated original library and copies it into ignored `worker/.wrangler/state/v3` using local Miniflare bindings. All 13 tracks become available locally. Files are hashed and verified after each write; existing different bytes under an immutable key are rejected. D1 publication and pointer changes happen together in a per-track batch only after its objects are verified. Interrupted runs retain the previous published pointer; identical reruns reuse existing objects. This is per-track, not an all-library transaction.

Local seed ownership is `gizmagick-admin-import`, an opaque placeholder to be mapped when admin authentication is added. It grants no login or write privileges. This seed tool does **not** probe durations/transcode audio and is not a production publisher. The later publication workflow must inspect/probe real audio before accepting uploads.

Start the backend:

```sh
npm run dev:worker:library
```

In another terminal:

```sh
npm run dev:remote
```

Open the Vite URL and select **Private Session**. Default local routing is frontend `/api/library` → Worker port 8787, and R2 media → `http://127.0.0.1:8787/api/library/media`. Vite's local proxy is not a production Pages function. Ports 5173 and 5180 are allowed in the API CORS configuration. Ensure port 8787 is free and check Wrangler's actual startup URL.

If an existing service occupies 8787, leave it running and start a separate Worker explicitly on 8788:

```sh
npx wrangler dev --config ../worker/wrangler.toml --local --port 8788 --var GIZMAGICK_MEDIA_BASE_URL:http://127.0.0.1:8788/api/library/media
```

For the matching preview in PowerShell:

```powershell
$env:VITE_GIZMAGICK_CATALOG_URL = 'http://127.0.0.1:8788/api/library/catalog'
$env:VITE_GIZMAGICK_MEDIA_BASE_URL = 'http://127.0.0.1:8788/api/library/media'
npm run dev:remote -- --host 127.0.0.1 --port 5180 --strictPort
```

Those environment values affect only that terminal. Clear them before a production build. A shell variable overrides env files; `.env.local` may also override a mode file. Restart after configuration or source-data changes. Run the seed again after source music changes to create local versions, then reload the player for a fresh catalog snapshot.

Remote source is **Private Session only** for now: choosing a room displays an explicit warning, blocks track loading, and does not connect its WebSocket. The existing name-based room protocol cannot safely pin an immutable version across republishing; this restriction must not be removed without implementing version-pinned synchronization. Legacy/manifest room playback remains enabled.

## Production rollout remains pending

Do not switch the live Pages build to `remote` yet. Complete audio-probed production import/publication, admin authorization for writes, and room track/version pinning first. Keep the original catalog and audio as rollback material.

When rollout is explicitly authorized, apply the migration to **remote** D1, prepare/verify immutable R2 objects and update D1 pointers last, then deploy this Worker configuration to the existing `gizmagick-worker`. Do not create a new Worker or edit bindings only in the dashboard. Check `/health`, catalog contents, version reads, audio/CORS and two-client version-pinned playback before frontend cutover. Remote D1 is still empty until these steps run.

A remote frontend build requires explicit production `VITE_GIZMAGICK_CATALOG_URL` (the deployed API's full catalog URL) and `VITE_GIZMAGICK_MEDIA_BASE_URL=https://media.gizmagick.com`, alongside `VITE_TRACK_SOURCE=remote`. `npm run build:remote` rejects missing/non-HTTPS/localhost URLs; `.env.remote` intentionally contains only local preview defaults. The normal build continues using the existing source unless overridden. Rollback removes the remote source override and rebuilds; do not delete source assets during rollout.

Verified: 95 tests pass, lint passes, legacy/manifest builds and a remote build with explicit production URLs succeed, and Worker deployment packaging passes a dry run (not a deployment). A remote build without production configuration is rejected. The actual local seed writes 13 tracks/189 objects; an identical rerun writes zero objects. API/schema tests cover visibility, historical reads, immutable versions, foreign keys, interrupted uploads and database publication/retries, escaped audio filenames, CORS, errors, and remote media URL substitution.

Browser checks passed for Lena's Home playback/pause/seek/resume, queued preloading into Testing Time and its Q1 transition, BleepBloop mode switching, Database section/mode previews, and the remote-room restriction. Existing React `onSelectStart` warnings remain unrelated to this integration. No remote migrations, music uploads or deployments were performed.
