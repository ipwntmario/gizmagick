# Phase 7N: prepare a copy-only Cloudflare rollout

Implemented and verified locally. **Not deployed; no public writes enabled.**
The [Phase 7M reserved plan](admin-cloud-intents-rollout.md#completed-immutable-reservation-october-13-2026-eastern)
remains the next cloud test. This checkpoint adds a separate legacy-publication
gate before requesting authorization for actual public copying.

## Plain-English rundown

The next test will copy the locked plan's audio and manifest into public storage,
one explicitly confirmed file at a time. Those files will become downloadable by
URL immediately, but the track will not appear in the catalog yet.

The existing shared publishing switch also enabled the older version-1 publisher,
which can both copy files and commit a catalog entry. Merely keeping the new
final-publication switch off would not disable that older path. A new explicit
`GIZMAGICK_LEGACY_PUBLICATION_ENABLED` gate now isolates it, so a later copy-only
deployment can keep **both** catalog-publication workflows disabled.

This does not change the fixed plan, its review, its private files, existing
public objects or playback. It needs no migration and changes no existing audit
records. Missing, malformed or false legacy opt-ins fail closed.

## Gates and UI

The shared `GIZMAGICK_PUBLICATION_ENABLED` flag remains a master public-write
gate, not a guarantee that every publication workflow is available. Each path
also requires its own effective feature flag and the existing admin/owner,
review, storage and migration checks:

- Legacy version-1 API/UI requires `GIZMAGICK_LEGACY_PUBLICATION_ENABLED = "true"`.
  Both its start and step endpoints (including pending intents) are disabled
  without this explicit opt-in. Its status endpoint is also disabled; existing
  records/public files are not deleted or relabeled.
- Bounded version-2 copying still requires its original separate copy gate and
  checks. It does not require the legacy gate.
- Bounded final checks/catalog publication still require their original
  separate final gate. They do not require the legacy gate.

The session's existing `capabilities.publishing` field describes the legacy
publisher, as does its `publication-panel`. Bounded-copy capability is reported
by the intent status's `publicCopyEnabled`; bounded final capability has its own
status/panel. Copy-only UI notices now explicitly warn that files become public
and catalog publication remains disabled, instead of describing the page as
entirely private when the legacy panel is absent.

Local simulator and bundled-runtime fixtures explicitly opt into legacy
publishing where they exercise the historical version-1 workflow. This is not
a production enablement. Other callers wishing to use that old publisher after
deploying this code must deliberately supply its new opt-in.

## Current configuration versus proposed authorized test

These proposed changes are **not applied**:

| Flag | Current repository | Proposed copy-only deployment |
| --- | --- | --- |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_ENABLED` | `false` | `true` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `false` | `true` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` | `false` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` | `false` |

The deployed Worker still has the preceding Phase 7M code/configuration; this
new gate has not been deployed yet. All deployed public-write flags remain off.
Before any authorized copy-only deployment, deliberately update the actual
configuration guard test to enforce the approved gate combination. Do not
simply remove its assertions to get an enabling change through tests.

## Verification

Tests cover missing/false/malformed legacy opt-ins, disabled legacy API/UI and
unchanged pending records without R2 access. An isolated proposed-config test
copies a synthetic bounded-review plan's two objects, retries exact positions
without copying the next file, and confirms that both legacy start/step and
bounded final start/commit remain disabled, with zero catalog/commit/final-pass
rows. An independent test confirms that an explicitly enabled bounded final
workflow still works with legacy publishing disabled.

The production configuration guard still verifies the current private-only
deployment configuration. Client tests retain separate confirmations for each
file and now check the copy-only initial status wording. Fixtures are not new
decoder evidence or a signed-in Cloudflare test.

All **546 tests** pass, including actual Vite/Wrangler bundled Worker and local
storage checks. Frontend/Worker lint, normal build and Git whitespace checks
pass. Normal player outputs remain `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB). The eight additional tests cover this gate
separation; no remote verification, migration or deployment is claimed here.

## Authorization and next cloud walkthrough

Obtain explicit permission to deploy copy-only capability and expose the two
objects of this exact reserved plan:

- Draft: `405b26f8-fd51-4f82-b3d7-9f676056eb72`, **Lena's Home (batched review check)**.
- Intent: `dd246b49-2cf1-45f5-8d35-a18938986807`.
- Track/version: `9bd4c047-74be-4012-b3ca-41e0cb9dea37` /
  `5bc50912-36f2-4328-80f6-11602a2bddab`.
- Plan SHA-256: `f27960d97b1c2607608ef10011c2e0acdd9cd29e60df1b39eba3755047191fea`.
- Public prefix: `tracks/9bd4c047-74be-4012-b3ca-41e0cb9dea37/versions/5bc50912-36f2-4328-80f6-11602a2bddab/`.
- Planned audio: `audio/Lena's Home.ogg`; planned data: `manifest.json`.

After authorization, rerun tests for the changed rollout configuration, verify
deployed flags/schema/bindings, and use signed-in read-only status to recover
the exact reserved plan before confirming any copy. The shared gate enables
bounded-copy capability for eligible administrator-owned drafts, not a technical
one-intent allowlist; the authorized walkthrough must remain limited to the
named test. No other draft may be copied under this authorization.

Each newly copied object must independently pass its existing private-source,
public-destination and exact-plan checks; old readiness batches do not suffice.
Verify receipt identity, public bytes/headers and read-only reload recovery.
Handle ambiguous responses by reading status before a separately confirmed
retry, never by automatic replay. Stop after the two exact copies; do not
enable either catalog-publication path, import the original library, change
ownership, cut over Pages/player loading or delete test objects. Disabling
copying afterward does not retract already public files.

Final catalog publication requires a later separately authorized rollout,
independent recent final verification and its own confirmation. Editing existing
published tracks, replacement versions and convenient clip replacement remain
separate planned work, not features completed by this test.
