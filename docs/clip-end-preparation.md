# Phase 7S: prepare clip endings from measured audio

Current cloud status: the admin controls are deployed in
[Phase 7T](admin-cloud-original-rollout.md); the signed-in read-only walkthrough
is pending. The local-only statements below describe the Phase 7S checkpoint.

Implemented locally; **not deployed to Cloudflare**. No migration, new backend
route, dependency or rollout flag is added. Original intake/publication and
public-write flags remain off. The live player and checked-in tracks are unchanged.

## Plain-English rundown

This is an editing assistant, not a publishing shortcut. It measures your local
audio and lists proposed clip endings. You inspect the list, explicitly apply
it to the admin editor, then separately save the private draft and run a fresh
normal review. Nothing is silently approved, saved, uploaded or published.

- Missing `clipEnd`: use the measured file duration.
- `clipEnd` longer than the file: shorten it to that duration.
- A shorter explicit endpoint: keep your intentional trim.
- Never move `loopStart` or `loopPoint`, change audio or rewrite source JSON.

Mode variants share one endpoint. If their durations differ by at most 50 ms,
the default uses the shortest common duration. Larger differences block automatic
changes: choose an explicit endpoint that fits every variant, or correct the
files. A valid shorter explicit endpoint is preserved even for unequal variants.
File endpoints round upward to a microsecond (at most one millionth of a second)
to preserve existing rounded musical timing. If `loopPoint` would still be after
the resulting endpoint, correct that timing manually; this tool cannot guess it.

## Walkthrough after the admin changes are deployed

1. Open an active, **unreviewed private draft** and expand its metadata editor.
   Edit other metadata first if needed. Keep the saved track/version IDs and
   entire `assets` object unchanged. Temporarily missing endpoints are allowed
   in this working text only, not in a saved canonical manifest.
2. Click **Download working metadata for preparation**. It includes unsaved edits;
   it is not a review package or a new version of the published manifest.
3. From the repository's `frontend` directory, run the following PowerShell command
   with your actual paths. The track root contains the referenced `audio/` folder.

   ```powershell
   node scripts/gizmagick-clip-ends.mjs --manifest "C:/path/working-metadata.json" --track-root "C:/path/track" | Set-Content -Encoding utf8 "C:/path/clip-end-proposal.json"
   $LASTEXITCODE
   ```

   A successful run returns `0` and a JSON proposal with `valid: true`. A failure
   returns `1`; inspect its errors, correct the working metadata/audio and rerun.
   Do not use a failed or partial report. `npm run tracks:prepare-ends --` accepts
   the same arguments when the local npm installation is available.
4. Select that file under **Local clip-end proposal**. The page checks its source
   fingerprint, IDs, measurements and exact proposed changes, then lists them.
   Selecting it does not edit anything. A changed working document needs a fresh
   export/proposal; asset or identity edits are refused here.
5. Click **Apply proposed endings to unsaved editor** after inspecting the list.
   Only those `clipEnd` fields change in the local text. Other unsaved edits remain.
   You can still discard them; no server save has happened.
6. Click **Save private metadata** separately. Existing strict schema/graph,
   ownership, asset immutability and stale-save checks apply. Approved/archived
   drafts remain locked. Download a **fresh review package**, run the ordinary
   local review validator, inspect/listen and complete the existing attestation
   workflow. A preparation proposal cannot be submitted as a review report.

Neither selecting nor applying a proposal makes an API write. A normal explicit
save does. Applying clears old review selections, confirmations and local
readiness/progress state so that earlier checks cannot approve the new text.
No-change proposals display a message and keep the Apply button disabled.

## Implementation and limits

`frontend/scripts/gizmagick-clip-ends.mjs` accepts only `--manifest` and
`--track-root` (or `--help`). It never writes files; the example's PowerShell
pipeline saves its stdout to a separate proposal file. Do not overwrite source
metadata with that output: it is a patch proposal, **not a manifest**. There is
no `--write`, publication switch or review-package input.

The tool uses the existing bounded, sequential full audio decoder. Existing
path/symlink protections, codec/sample consistency and supplied size/hash/duration
constraints are retained. It validates structure and musical references before
decoding, temporarily substituting loop endpoints in a private measurement clone
only; it then recomputes edits from the untouched source and validates the result
against measured durations. A bad graph, file, fingerprint, explicit invalid
endpoint or musical transition prevents exporting any usable changes.

Limits remain 256 KiB metadata, 256 assets, 2,048 clips, 128 sections, 16 MiB and
30 minutes per audio file; proposal output/selection is bounded at 1 MiB. The
canonical schema and strict review validator still require explicit valid
endpoints. No implicit playback fallback is introduced.

The proposal has scope `local-metadata-preparation`, policy
`gizmagick-clip-ends-v1`, `approval: false` and `publishing: false`, with a compact
JSON source checksum, per-file measurements and exact changes. It exports no
enriched or publishable manifest. Browser checks are editing safeguards, **not
proof of decoding or authority**; the existing fresh review/attestation remains
the publication prerequisite. Local preparation can run before private upload;
normal review later checks the exact uploaded files.

For imported originals, save only the editable private draft. The immutable
original-source checksum/document, original library ID/key and fresh draft
version ID remain intact. Checked-in manifests/audio are not repaired in place.
Approved/published versions and future published-track revisions are out of scope.

## Local verification and next step

On October 18, 2026, all **628 automated tests pass**, including 36 new policy,
real-audio, private-edit/review and admin-client cases. Both existing bundled
Worker tests now execute preparation in their emitted browser scripts too.
Frontend, shared-policy and Worker-admin lint pass. The normal production build
retains player assets `index-FinxNOWL.css` and `index-CQBPIrW7.js`.

Real UglyOnPurpose audio yields exactly one proposal: `Main_a.clipEnd` changes
from `16.153855` to `13.846168` seconds (decoded duration
`13.846167800453514`). Its corrected private metadata passes ordinary measured
review, while the unchanged original still fails it. A temporary database test
preserves source provenance, rejects the stale package, accepts a fresh review
and keeps the track private/unpublished. These automated attestations are not
human attestations or cloud verification.

Tests also cover missing endpoints with real Lena's Home audio, intentional
trims, mode-length ambiguity, rounded timing, malformed values, stale fingerprints,
file-picker behavior, preview/apply/save separation and locked drafts. Both
bundled Worker page scripts exercise their serialized preparation policy.

Next: review the private-only Cloudflare rollout of migrations 0010–0011 and the
admin changes, keeping original publication/public writes off. Real original
reservation/upload needs separate authorization, followed by the ordinary fresh
review and separately confirmed publication. Live-player cutover remains later.
