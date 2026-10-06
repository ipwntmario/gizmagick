# Version-pinned Gizmagick rooms

Remote-source online playback uses `gizmagick-library-v1`. The catalog is a snapshot of the current published versions; a room instead keeps explicit `{trackId, versionId}` references for its selected and queued tracks. Republishing a track cannot replace either reference. No database migration is required for this protocol change.

## Trust and compatibility

- Remote clients send `trackSource: "remote"` and `roomProtocol: "gizmagick-library-v1"` in `HELLO`. They wait for a matching `ROOM_PROTOCOL` acknowledgement before enabling room playback. Old Workers produce an explicit protocol error instead of name-based fallback.
- The Worker validates selection/queue references against D1: both track and version must be published, and the track must be public. Historical published versions are valid. The Worker derives compatibility names from D1; clients cannot choose media URLs through socket messages.
- The repository reads the exact published-version endpoint without consulting the current catalog. It verifies returned identity, manifest metadata, and canonical media URLs. Missing/private/archived versions fail explicitly; newer versions and legacy assets are never substitutes.
- Legacy and build-time-manifest clients retain the name-based protocol. A room cannot mix these clients with remote clients. Existing browser preference keys are unchanged.

The existing self-declared room roles still control who may direct playback. They are **not admin authentication** and grant no catalog/upload permissions. Authentication and publication endpoints remain future work.

## Selection, readiness, and synchronization

`SET_TRACK`, `PLAY`, transport events, and sync snapshots include `trackRef` and `selectionId`. The selection ID is the room's numeric RNG seed, regenerated for each selection. `STATE` includes the selected and queued references. Queue messages carry their own track reference; promotion retains that exact version.

Remote readiness starts false on every connection. A client acknowledges readiness only after it has loaded and decoded the selected version, with its matching selection ID. An old load completion cannot acknowledge a newer selection, including a same-name re-selection. Playback's readiness override can bypass peers that are not ready, but cannot authorize a wrong-version command.

Track-scoped requests with stale references or selection IDs are rejected. Database-backed commands are serialized per room, so a slow earlier lookup cannot overwrite a newer choice or race a clear command. Asset caches distinguish versions even when compatibility names match.

Late joiners and reconnecting clients first load the pinned version, then request the director's precise playback snapshot rather than replaying the original start event. A paused snapshot restores the decoded clip/section/mode and frozen offset without starting audio. Resume preserves the existing playback rules: simple tracks continue from the saved offset; dynamic tracks restart the paused clip. Socket attachments and remote-room state are persisted for Durable Object hibernation. This is not a guarantee of transactional recovery from every storage failure.

A browser's catalog stays a snapshot until reload. To select a newly published version, refresh the catalog and explicitly choose it; active or queued playback does not update automatically. Published media must remain available while rooms can refer to it. Removing a track from the public catalog is not a way to revoke already public R2 files.

## Local verification and rollout

Follow the [Cloudflare local setup](cloudflare-library.md), then open two clients using the same online room and Worker. Check selection/readiness, playback, late joining, queue promotion, section/mode controls, pause/resume, and reconnects. Automated tests also republish a same-name track while a room has its old version selected and queued, and verify historical loads without current-catalog fallback.

Deploy the compatible Worker before cutting the frontend over to remote source. Persisted remote rooms retain their source; this implementation does not automatically convert existing name-based rooms. Use separate room IDs during staged mixed-source testing. Production publication, admin authorization, remote migrations, and deployed two-client checks remain pending; all checks for this change used local resources.
