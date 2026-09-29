# Wizamp

A browser-based dynamic music player for tabletop sessions. Tracks can loop, transition between sections, switch musical modes, and synchronize playback across a room.

Live app: [wizamp.app](https://wizamp.app).

## Local development

Use Node.js 22.12+ and npm. From `frontend`:

```sh
npm ci
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
VITE_WS_URL=ws://127.0.0.1:8787/ws
```

Open two browser tabs with the same `?room=test-room` URL. Choose Audio Manager in one and Player or BTS in the other, unlock audio in both, and select a track. Online Play waits for room readiness. For an already deployed backend, use its `wss://.../ws` address instead.

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
- `frontend/src/data`: catalog loading and shared track ordering.
- `frontend/src/components`: controls, settings, and the music database.
- `worker/src/index.js`: Cloudflare Worker and room hub.

## Music data

`frontend/public/trackData.json` contains a `tracks` object keyed by track name. Each entry names its `basePath`, `firstSection`, `simple` flag, and optional display name/test flag.

Each track folder contains:

- `clipData.json`: a `clips` object. Each clip specifies its audio `file` (a string or a map of mode names to files), `loopStart`, `loopPoint`, `clipEnd` in seconds, and `nextClip` choices.
- `sectionData.json`: a `sections` object defining `firstClip`, available `nextSection` choices, optional `modes`, and section type (`auto` or `end` where applicable).
- `audio/`: audio files referenced by the clip metadata. The base mode is named `base`.

The scripts in `frontend/scripts` support audio import and older metadata migration. `process-clips.mjs` requires FFmpeg/FFprobe and may write metadata or convert audio; review its header before running it. Existing `.bak` metadata files are retained as migration backups. Audio and musical metadata are not modified by code cleanup.

Pins, display-name overrides, volumes, and UI preferences are local to the browser. Identity uses `wizamp.role` and `wizamp.displayName`; the former underscore-separated keys are read as migration fallbacks.
