# TrackManifestV2 contract and migration

Phase 1 defines the playback contract; Phase 2 provides validation, conversion and an engine compatibility adapter. Phase 3 connects the local player and previews through a shared Gizmagick repository, with manifest loading selectable and legacy loading available for rollback. Phase 4 adds the D1 catalog and remote loader, verified using local simulated D1/R2. The cloud resources have been provisioned separately; remote migrations, publication, admin write endpoints and authentication are not enabled by these local changes.

The authoritative structural contract is [`shared/track-manifest.schema.json`](../shared/track-manifest.schema.json), using [JSON Schema Draft 7](https://json-schema.org/draft-07). Semantic rules are in [`shared/track-manifest.js`](../shared/track-manifest.js). [`examples/track-manifest-v2.json`](examples/track-manifest-v2.json) is a validated illustrative track, not a playable audio package.

## Document boundaries

One track version has one `manifest.json` containing `schemaVersion`, `versionId`, `track`, `assets`, `clips` and `sections`. JSON is the interchange and playback format. Optional future YAML authoring or a visual editor must compile to the same document and pass the same checks.

| Data | Intended location | Why |
| --- | --- | --- |
| Track ID, owner, visibility, draft/published status, current version pointer, timestamps | D1 | Server controls permissions and catalog queries |
| Immutable manifest and audio | R2 version directory | Player downloads a complete, consistent snapshot |
| Mutable draft manifest | Future authenticated draft API and private storage, not the public media bucket | Draft must not change a published version |
| Graph positions, zoom, collapsed groups | Future editor sidecar document | Editor layout can change independently of musical behavior |

Expected object layout: `tracks/{trackId}/versions/{versionId}/manifest.json` and `tracks/{trackId}/versions/{versionId}/audio/*.ogg`. Publication should verify the uploaded objects first and update D1's pointer last. An interrupted upload must leave the old pointer active. Ownership and publication status inside an uploaded file cannot grant access and are intentionally absent from the manifest.

## Identity and versioning

`track.id` and `versionId` are UUIDs, independent of display titles. Create a track ID once and keep it through renames. A slug is a human-readable URL hint, not a storage key or unique identity. Two tracks may have the same title or slug; their IDs distinguish them.

Asset, clip, section and mode IDs are dictionary keys local to the track. Once saved, treat these keys as stable; edit display labels instead. Existing musical keys such as `PreQ_a1` are retained to preserve room synchronization and browser preferences during migration. New authoring tools may issue opaque IDs. Shared mode IDs preserve a compatible mode when moving between sections. Reserved JavaScript property names, slashes and control characters are rejected.

The legacy converter generates initial UUIDv5 track IDs from the original catalog keys and asset IDs from filenames. Persist those IDs after import; do not run renamed catalog entries through initial ID generation. The converter accepts a retained `trackId` when needed. New user-created tracks should get randomly generated UUIDs. Generated import version IDs are repeatable and include metadata plus file hashes; changes to metadata or audio produce a different snapshot ID. Future publishing can issue a new UUID instead of reproducing this initial import algorithm.

`schemaVersion: 2` names this first combined format, distinguishing it from the existing split documents. Unknown versions and unknown fields fail validation. New semantics require an explicit schema revision or documented additive contract change. Structural defaults do not silently mutate input.

Published versions are immutable. A room must eventually synchronize `{trackId, versionId}`, and its version stays pinned until explicitly changed. Selecting the latest version once and caching by `(trackId, versionId)` prevents a republish from splitting a room across different musical graphs. Existing room messages and local-storage name keys are unchanged in Phases 1–2; their migration belongs to the loading/network work.

## Playback fields

`track` requires `id`, `slug`, `title`, `firstSection`, `simple`, and `test`. `firstSection` must reference a section. `simple` preserves the player's simple-track seek/pause/UI behavior; `test` preserves the catalog filter. D1/API catalog responses must agree with the manifest version they describe.

Each asset defines a relative `path` of the form `audio/Filename.ogg`. Paths are unencoded, flat filenames; the loader encodes the filename once when constructing a URL. External URLs, query strings, traversal and hidden filenames are rejected. A server chooses the version base URL, so a manifest cannot choose an arbitrary host. OGG is the supported format for this migration; adding other containers is a future schema/import decision.

Optional asset fields are `durationSeconds`, `byteLength` and `sha256`. Duration is a measured audio property, not a value inferred from `clipEnd`. The migration CLI records bytes and SHA-256 and checks that each audio file exists and is nonempty. It does **not** decode audio, run FFprobe, transcode files or establish measured durations. The later ingestion service must inspect actual file content and probe duration before publication. A JSON schema check alone cannot establish that a file is valid audio.

Each clip requires:

- `assetsByMode`: map of mode IDs to asset IDs, including `base`. Physical audio can be shared by multiple logical clips. This preserves Testing Time's distinct Post-Q playback paths without duplicating uploaded files.
- `loopStart`, `loopPoint`, `clipEnd`: seconds on the source audio timeline. Require `0 <= loopStart < loopPoint <= clipEnd`. At `loopPoint`, the engine chooses the next clip or queued section/mode; `clipEnd` is the end of the outgoing tail. Equality is valid for clips without a tail. When measured durations are available, every variant must accommodate `clipEnd`, with 50 ms tolerance for container/decoder rounding.
- `transitions`: array of `{to, weight}` entries. IDs must exist and each target appears once. Weights are positive integers, at most 1024 each and 4096 total. An empty array means no automatic next clip; a self-reference expresses a loop. Cycles are valid in ordinary musical sections.

Probabilities are `weight / sum(weights)`. The compatibility adapter expands weights into the existing choice list. The engine's sorting and RNG draw rules remain unchanged, including the unusual case of a repeated choice pointing to only one distinct target. This matters for synchronized and late-join playback. A future native weighted selector must preserve the same sorted intervals and RNG consumption.

Each section requires `title`, `firstClip`, `clips`, `type`, `nextSections` and `modes`. Optional `buttonLabel` and `baseModeLabel` preserve current section button labels and base mode labels. Arrays are explicit even when empty.

`clips` records membership for the future editor. It must include `firstClip` and every target reached through member clip transitions. Membership follows actual graph edges, not naming conventions. One logical clip may belong to multiple sections. Clip edges stay within each section's declared membership; section changes use `nextSections`.

Section types:

- `manual`: `nextSections` lists available choices in display order. An empty array is valid.
- `auto`: exactly one next section and at least one reachable self-loop clip. Preserve the current engine's handoff: a reachable clip with a self-loop queues the next section at its loop point. This schema does not introduce new automatic scheduling behavior.
- `end`: no next sections, and every reachable clip path must terminate. Chained ending clips are valid; ending cycles fail validation.

`modes` lists additional mode IDs in display order; `base` is always implicit. If a clip lacks a requested variant, use its base audio and issue a validation warning. Timing applies to all variants of a logical clip; independently timed mode variants are outside this contract.

Missing references, invalid timing, duplicate paths/targets, invalid membership, ambiguous auto targets and nonterminating endings are errors. Unreachable sections, unused clips/assets, unreachable section members and missing mode variants are warnings. Warnings permit intentional work-in-progress material but should be shown before publication. Validation must run on the server even if the editor also validates locally.

## Local tools

From `frontend`:

```sh
# Default: validate conversion and fingerprint all catalog tracks, write nothing.
npm run tracks:migrate

# Focus on the dynamic-track stress test.
npm run tracks:migrate -- --track "Testing Time" --dry-run

# Export standalone manifests to ignored .track-manifests/<trackId>/<versionId>/.
npm run tracks:migrate -- --write

# Or choose another export location.
npm run tracks:migrate -- --write --output ./my-manifest-export

# Validate a manifest's structure and graph only.
npm run tracks:validate -- ../docs/examples/track-manifest-v2.json

# Also verify existing files, sizes and hashes when present.
npm run tracks:validate -- <manifest-path> --audio-root "public/tracks/Testing Time"
```

The exporter never rewrites source JSON or audio, updates the catalog, uploads content, or changes live loading. It validates all selected tracks before exporting. Identical exports are no-ops; an existing differing file is never overwritten. Output is one document per version; audio remains in the source folder until the R2 importer copies it. A changed source produces a new version directory. The CLI's JSON reader rejects parse errors, and the converter refuses unknown legacy fields instead of silently dropping them.

Tracks not listed in `trackData.json` are reported and not imported. `Lena's Home` is now included in the catalog as a simple, non-test track.

The reusable functions are `convertLegacyTrack`, `validateManifest`, `checkAudioFiles`, and `fingerprintManifest` in `frontend/scripts/lib/track-manifests.mjs`. Structural validation uses Ajv at tool time. `validateManifestSemantics` and `manifestToEngineData` in `shared/track-manifest.js` have no Node or library dependencies. Always run structural and semantic validation before calling the engine adapter. For the eventual Worker, compile a standalone schema validator during the build; Ajv's runtime schema compilation uses code generation that should not run inside a Worker request.

## Phase 3: local loading

From `frontend`:

```sh
npm run dev:manifest
npm run build:manifest

# Rollback/default when VITE_TRACK_SOURCE is not set elsewhere:
npm run dev
npm run build
```

`frontend/.env.manifest` sets `VITE_TRACK_SOURCE=manifest` for the manifest-mode commands. Alternatively set the variable in `.env.local` or the shell before starting Vite. A shell variable takes precedence over env files. Restart after changing the source or editing musical metadata/audio. Unknown source names fail visibly instead of choosing a fallback.

The `gizmagick-local-manifests` Vite plugin validates and fingerprints all catalogued tracks at startup/build time. It serves `/gizmagick-tracks/catalog.json` and `/gizmagick-tracks/{trackId}/{versionId}/manifest.json` in development and emits the same files into `dist` for a manifest build. It neither writes generated metadata into source folders nor depends on `.track-manifests` exports. Development responses bypass caching and unknown generated paths return JSON 404s. Development snapshots are fixed until restart.

The generated catalog keeps compatibility names as UI keys and attaches track ID, version ID, manifest URL, original audio base path and display/filter metadata. `trackRepository.js` loads the catalog and caches/coalesces track metadata requests by source, identity and version. The player, queued-track preload, library durations and Database previews all use it. Failed requests are removed from the pending cache so a user can retry. Database failures display a retryable message instead of expanding a blank track.

The browser validates structure using a standalone validator compiled from the canonical schema by Vite, then applies the shared graph checks. Ajv and Node APIs do not ship as a runtime compiler. A catalog/manifest ID, version or display/playback metadata mismatch fails before conversion. Invalid manifest data never silently falls back to legacy JSON. The compatibility adapter supplies existing engine fields and filenames, preserving mode fallback, labels, weights and RNG behavior.

Audio continues to use the original `public/tracks` URLs in Phase 3. The manifest snapshot IDs describe the computed file hashes at build time, but these audio paths are not immutable version directories yet. Immutable R2 audio delivery and the room protocol's track/version pinning remain required for remote publication. Browser preferences and existing name-based messages have not been renamed. New implementation names use Gizmagick.

## Checks and next phase

`npm test` covers conversion of all 13 catalog tracks, actual audio file references, timing/labels/modes, deduplication, transition probabilities, RNG draw counts, repeatability, changed version content, unknown fields, broken graphs, unsafe paths and missing files. Testing Time retains 162 logical clips, 82 sections and 129 physical assets. The example document is validated too.

Repository tests compare all 13 tracks across both sources, including duration previews, audio URLs and transition outcomes. They exercise concurrent reads, cache reuse, failures/retries, malformed JSON, schema/graph errors, catalog identity mismatches, changed versions, the browser's standalone validator, and development/build document serving. Existing engine and room tests remain part of `npm test`.

Phase 3 browser smoke checks covered Lena's Home playback/pause/seek, Testing Time section transitions, Database section/mode previews, and two local clients synchronizing BleepBloop with Modes, a mode change, queued Lena's Home, pause and seek. The room protocol remains name-based in this phase; these checks do not establish remote version pinning.

Phase 4's schema, read-only catalog/version API, remote repository and local-only importer are described in the [Cloudflare library guide](cloudflare-library.md). Keep the original catalog/assets as rollback material. Production migration, an audio-probed publication/import workflow, and room track/version pinning remain pending. Remote loading is therefore opt-in and restricted to Private Session for now.
