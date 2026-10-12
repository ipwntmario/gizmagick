# Phase 6E: private metadata editing

Implemented locally on October 9, 2026; enabled on the existing Cloudflare Worker
on October 12, 2026. **Signed-in cloud editor verification is still pending.**
This adds a JSON editor for an owner's unreviewed new-track drafts, not the visual
graph editor, published-track revision workflow, ownership transfer, or publication.
The attested cloud Lena's Home smoke-test draft remains unchanged and locked.

## Local walkthrough

From `frontend`, run `node scripts/gizmagick-admin-preview.mjs` and use the printed
loopback admin URL. This uses the existing isolated synthetic login and temporary
D1/R2; never tunnel or deploy the preview harness. Create a draft as described in
[private intake](admin-drafts.md). Audio can be uploaded before or after edits.

1. Open the draft and expand **Edit private metadata (JSON)**.
2. Edit its title/slug, first section, simple/test settings, sections, modes,
   transitions, labels, or clip timing. These use the existing
   [TrackManifestV2 contract](track-manifest-v2.md).
3. Keep `track.id`, `versionId`, and the entire `assets` object unchanged,
   including asset IDs, paths, duration constraints and fingerprints. Adding,
   replacing or renaming audio requires a new draft in this increment.
4. Click **Save private metadata**. Structural and graph errors appear in the
   status area. A failed save retains your text so you can correct or copy it.
5. Inspect the saved graph warnings. After a changed save, download a fresh
   review package, rerun the pinned local validator, and explicitly attest as
   described in [administrator review](admin-review.md).

The editor clears any selected report/confirmation when you type. While edits
are unsaved, uploads and review actions are blocked. **Discard unsaved edits**
restores the loaded document after confirmation, without a server write.
Reopening a draft or creating another one asks before discarding unsaved text.
There is no browser autosave/local storage: copy unfinished work before manually
reloading, navigating away, or closing the tab.

Attested and archived drafts cannot be edited, even by their administrator owner.
The editor and save button are locked. An attestation is never removed or reset
to allow edits. Use a new draft for new work; reviewed-copy/audio reuse and
published-track revisions require a separate design.

## Server contract and concurrency

`POST /api/admin/drafts/:id/metadata` accepts a JSON object with only two fields:
`expectedManifestSha256` (the checksum from the loaded draft detail) and
`manifest` (the complete manifest object, not a JSON string). Draft
detail now includes `manifestSha256` and `metadataEditable`; the verified session
advertises `capabilities.metadata`. All access stays behind the existing signed
Access JWT, administrator role, owner lookup, exact Origin, and CSRF header.
Ownership, trust and publication fields are rejected, never inferred from JSON.

Requests have the existing 256 KiB limit, including the checksum wrapper, and
the existing graph bounds (256 assets, 2,048 clips, 128 sections). The endpoint
reruns the canonical schema/graph validator. It checks asset values independent
of JSON property ordering and rejects all identity/asset changes. No uploaded
file or allocation is rewritten. Graph validation alone is not audio decoding;
clip ends beyond real audio are caught by the subsequent local review run.

A conditional D1 UPDATE compares the loaded canonical document, owner and active
status and requires that no immutable review exists. Competing changed saves,
archival, and attestation cannot silently overwrite the loaded version. A stale
save returns 409: copy your edits, reopen the latest draft, then reconcile them.
An exact-content retry after a lost successful response is a no-op; an attested
or archived draft is still locked, including retries.

Private track/version IDs stay allocated to this draft while its unreviewed
metadata changes. Its manifest checksum is the concurrency/review identity.
Nothing is served as a published playback version. Existing pending packages
are retained, but a changed snapshot fails review; requesting a package for the
new snapshot replaces the job. Conditional attestation writes also compare the
exact metadata, so a concurrent old-graph review cannot succeed after an edit.
Published version immutability and historical attestations are unchanged.

This initial editor retains only current unreviewed metadata and its updated
timestamp; it is not an edit-history/undo system. No review audit is deleted.

## Rollout boundary and verification

`worker/wrangler.toml` records `GIZMAGICK_DRAFT_METADATA_ENABLED = "true"`.
Editing additionally requires uploads and reviews enabled, so it cannot run
without the ability to check migration 0003's immutable review records. Disabled
metadata requests return 503. No new migration, binding, dependency or secret
is needed. The isolated local preview and runtime tests enable the flag.

Automated checks cover editing before/after uploads, unchanged private objects,
reload persistence, exact retries, stale saves, unknown fields, forged identity
and trust, asset modifications, graph errors, bounded requests, missing review
tables, disabled rollout, owner/administrator isolation, and races with archival
and attestation. Browser-script tests cover report clearing, locked review and
editing controls, invalid JSON, retained text on failed saves, and prevention of
silent unsaved-text loss. Both actual Vite- and Wrangler-bundled Workers exercise
authenticated metadata save/reload and the local decoder/review workflow.
These automated tests do not substitute for signed-in cloud browser checks.

An actual browser walkthrough on October 12 used the isolated loopback preview,
synthetic Access identity, and temporary D1/R2. Invalid JSON retained the editor
text; a valid title change saved and persisted after reload; an unknown first
section was rejected without losing the text or changing the saved document.
This disposable draft contained metadata only: no audio upload, decoding,
attestation, or publication was attempted during this browser walkthrough. The
preview was stopped and its tab closed afterward.

Cloud preflight found no pending migrations, no custom domain on
`gizmagick-drafts`, and its public development URL disabled. Deployment version
`f9dfe9ad-09b0-462a-8066-3f7010f0f596` enables metadata editing and retains the
existing D1, both R2 buckets, RoomHub namespace, Access identifiers, and email
allowlist secret binding. No new routes, bindings, migrations, dependencies,
secrets, Access policy changes, or Pages deployment were needed.

After deployment, `/health` and the empty public catalog returned 200. Anonymous
requests to `/admin`, `/api/admin/session`, and the metadata POST endpoint returned
302 redirects to the existing Access team domain. Read-only D1 checks before and
after deployment found one private draft, one asset, one immutable review, and
zero published tracks/versions. The retained Lena's Home review hashes stayed:

- Report: `159a54dc722c00c5f754b6058dc0aa6f7222312e0cfea8ae4ce7489d1318a6b8`
- Snapshot: `d693253b38f314514f111ff7acfce5ed7f068f59f84984b54eef1b9390805c80`

The cloud admin browser reached the Access sign-in page. No authentication was
automated and no cloud draft was created or edited. A fresh administrator login
is needed to verify the deployed controls; a cloud save walkthrough requires a
separately approved disposable unreviewed draft, not the retained attested draft.

All **256 tests**, frontend/Worker lint, the normal frontend build, and Git
whitespace checks pass. The player asset filenames/sizes are unchanged from the
previous checkpoint. No source music/data, credentials, or user `.gitignore`
change is included in this implementation checkpoint.

To disable editing, set the metadata flag to `"false"` and redeploy the existing
Worker; this does not remove saved metadata or review records. Keep uploads and
reviews configured independently. No rollback was performed during this rollout.

Next: finish signed-in cloud editor verification. Do not edit the retained
attested smoke-test draft. Production publication,
ownership mapping for existing library tracks, staged library import, and player
cutover remain separate steps. Browser package-download delivery and real
sign-out/denied-account checks remain pending from the previous phase.
