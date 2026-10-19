# Phase 7P: original-library audit and import preparation

Next implementation checkpoint: [Phase 7Q private original intake](admin-original-imports.md)
preserves identity/ownership in local tests and remains disabled on Cloudflare.
It reserves a private identity and cannot publish originals yet. The remaining
gates below describe the audit checkpoint, not permission to import or publish.

This is a **local, read-only checkpoint**, not an importer or publication rollout.
No Worker deployment, cloud queries/writes, uploads, source-music edits or player
cutover occur. Phase 7O's two published cloud smoke tests remain separate from
the original library; all public-write flags remain disabled.

## Plain-English rundown

Before moving the actual library, we take inventory and check that the saved
combined documents still describe the current tracks. We fully decode the audio
with the existing local validator, check clip timings, and preserve original
track IDs and catalog names. A proposed owner is only a note in the report—it
does not grant access or change the database.

This catches stale documents or broken tracks before uploading. Passing these
checks does **not** approve a track or skip the private review/publishing process.
The live player continues to load its existing files.

## Run it

From `frontend`, after installing the locked dependencies:

```sh
npm run library:audit
npm run library:audit -- --track "Testing Time"
npm run library:audit -- --json
```

The direct equivalent is `node scripts/gizmagick-library-audit.mjs`.
`--help` explains the arguments. `--json` sends the report to standard output;
progress goes to standard error. The command never writes a report file itself.
It has no upload, remote, output-directory or write switch. An unknown argument
is rejected before auditing. Exit code 1 means a local check failed (or the input
was invalid); exit code 0 means the **selected local tracks** passed, not that a
cloud import is ready. A one-track audit does not validate the rest of the catalog.

An optional `--owner-id` takes the opaque `access:` ID from a verified admin
session (64 lowercase hex characters after the prefix), **not** an email, token
or password. Without it, ownership is explicitly `unassigned`; with it, ownership
is `proposed-only`. It must be checked against a fresh authenticated session
before any future guarded import. Never use the local seed's placeholder
`gizmagick-admin-import` as a real account.

The audit uses bounded metadata reads, the existing graph rules, source-folder
containment checks (including resolved links), audio fingerprints, and the same
sequential, bounded decoder as `tracks:probe`. It compares each checked-in
`manifest.json` with a regenerated legacy-data/audio snapshot; a difference is
reported, never overwritten. It does not pick an authoritative source if the
legacy pair and merged document disagree. Unlisted folders are reported but not
added to the catalog; this includes the intentionally ignored `_WAV` folder.

This is **not an atomic filesystem snapshot**: keep the source files unchanged
during the run and repeat after edits. Later package/review/publication checks
must independently pin and recheck the exact files. The local report is not an
administrator attestation, server decoding, a reservation or a cloud-state check.

## Verified local inventory — October 15, 2026

The full command was run against the actual repository audio, with the known
administrator's opaque ID recorded as a proposal only:

- 13 catalog tracks; all 13 checked-in merged manifests match current source
  metadata and file fingerprints.
- 176 per-track audio asset references, totaling **56,473,347 bytes** (about
  53.86 MiB). References shared across tracks still occupy separate version
  namespaces; this is not a globally deduplicated storage estimate.
- All 176 assets decoded. **12 tracks pass; one fails timing validation.**
- Testing Time passes with 129 physical assets, 162 logical clips, 82 sections
  and 21,700,676 audio bytes.
- Original Lena's Home passes with ID
  `5c22b71c-2af0-5483-8a25-821b726707e1`. Neither cloud smoke-test identity
  is substituted for it.
- `BleepBloop UglyOnPurpose` still has `Main_a.clipEnd = 16.153855`, but
  `audio/Main_aTEST.ogg` decodes to 13.846167800453514 seconds. The audit
  reports `past-audio-end` and exits 1, as intended. No timing was corrected,
  test flag changed or track silently omitted.

The source inventory corresponds to 176 audio objects plus 13 manifest documents
(189 references), **not a final upload plan**. Final reviewed manifest bytes,
version IDs, exclusions, destination collisions and cloud state remain unverified.

## Identity, versions and the next implementation boundary

The original catalog keys and deterministic track UUIDs must survive migration:
browser preferences and compatibility mappings already use them. Do not recreate
originals using the current new-track form and then match records by title or
audio checksum. That form deliberately allocates fresh identities. The cloud
smoke tests must remain independent records unless separately authorized cleanup
is implemented later.

`sourceSnapshot.versionId` and `manifestSha256` describe the existing
fingerprinted legacy snapshot. The hash is of compact `JSON.stringify(snapshot)`,
not the indented checked-in file. Measured durations are reported separately;
the audit does not insert them under an existing immutable version ID or emit a
publishable manifest. A later reviewed version may have a different ID and
different manifest bytes. Destination layout remains
`tracks/{trackId}/versions/{reviewedVersionId}/…`; no paths are reserved here.

Next work, in order:

1. Build and locally test **identity-preserving private intake** for selected
   original tracks, with an explicit authenticated owner/legacy-key mapping.
   Check current D1 identities, reserved intents and storage destinations;
   fail on conflicts instead of adopting unrelated records. Preserve the
   existing new-track path and published immutability.
2. Explicitly choose which original test tracks belong in the import. Keep the
   malformed test private/excluded, or correct it through a separately reviewed
   source edit; do not bypass validation. Other passing tracks can be handled
   independently.
3. Obtain approval before real private imports, then use exact packages,
   personal validation/confirmation and the existing guarded publishing steps.
   Verify Testing Time's real larger workflow, not only structural fixtures.
4. Verify remote playback and pinned two-client rooms, then plan the explicit
   frontend release/cutover with the legacy source retained for rollback.

Existing-published-track revisions, clip replacement conveniences, cleanup,
multi-user uploads and the visual graph editor remain separate features. This
checkpoint does not make updates to already-published tracks possible yet.

## Verification

The new orchestration tests cover preserved identities, ownership proposals,
read-only behavior, changed audio/version drift, manifest disagreement, missing
files, escaping source directories, incomplete measurements and rejected write
arguments. Their synthetic fixtures are **not decoder/cloud proof**. A separate
test decodes the real original Lena's Home; the full-library run above supplies
the actual 176-asset evidence. No cloud integration claim is made here.

All **559 automated tests pass** (including ten new audit tests), frontend and
Worker-admin lint pass, and the normal production build passes. Its player
assets remain `index-FinxNOWL.css` / `index-CQBPIrW7.js`, unchanged from Phase 7O.
The selected-track JSON CLI also returns a successful, explicitly local-only
report for original Lena's Home with ownership unassigned when no ID is supplied.
