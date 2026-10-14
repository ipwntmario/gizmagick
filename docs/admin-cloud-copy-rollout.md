# Phase 7N: authorized copy-only Cloudflare rollout

Completed October 13, 2026, Eastern. The explicitly authorized audio and manifest
are public by URL, with exact copy receipts and reload recovery verified.
The track is **not listed in the catalog**. New public writes were disabled
again after the test; both catalog publishers stayed disabled throughout.
The [Phase 7M reserved plan](admin-cloud-intents-rollout.md#completed-immutable-reservation-october-13-2026-eastern)
remains unchanged. This record includes the original local gate-separation
preparation and the subsequent separately authorized cloud copy test.

## Plain-English rundown

The test copied the locked plan's audio and manifest into public storage, one
explicitly confirmed file at a time. Those files are downloadable by URL, but
the track does not appear in the catalog yet. Its private originals and review
remain unchanged; disabling copying does not retract the public files.

The existing shared publishing switch also enabled the older version-1 publisher,
which can both copy files and commit a catalog entry. Merely keeping the new
final-publication switch off would not disable that older path. A new explicit
`GIZMAGICK_LEGACY_PUBLICATION_ENABLED` gate now isolates it, allowing the copy-only
deployment to keep **both** catalog-publication workflows disabled.

The original local gate-separation preparation changed no cloud state. The
subsequent authorized deployment/copy test added two public objects and two
receipts, but did not change the fixed plan, review, private files, earlier
public objects or playback. No migration or existing-audit edit was needed.
Missing, malformed or false legacy opt-ins fail closed.

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

## Final configuration versus temporary authorized test

The temporary copy-only combination was deployed and tested, then closed:

| Flag | Final repository/deployment | Temporary copy-only deployment |
| --- | --- | --- |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_ENABLED` | `false` | `true` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `false` | `true` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` | `false` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` | `false` |

Copy-only version: `df69bf2a-df1b-4d1e-a648-cb0e9dc9b300`, created
`2026-10-14T02:20:14.21867Z` (October 13, 10:20 p.m. Eastern).

Final write-disabled version: `61b343b4-8c53-4d43-94dd-3cdb6b64880d`, created
`2026-10-14T03:11:10.771186Z` (October 13, 11:11 p.m. Eastern).

Both share script ETag
`0812e9588a3f921587818cbfa0a7eb644c17f777923b487ac58ee213fb26c243`;
closing the test changed flags, not handler code. Readback verifies the final
four write switches are false and the administrator secret name remains present
without reading its value. D1/media/drafts/room bindings, Access identifiers,
origins and routes are unchanged. Migrations 0001–0009 were already applied;
no migration was performed. No Pages deployment or live-player cutover occurred.

The actual configuration guards were explicitly adapted and tested before the
copy-only deployment, enforcing shared/copy true and legacy/final false. After
closing writes, the production guard was restored to require all public-write
flags false; the separate isolated copy-only test remains. Future enabling must
again deliberately review/update these guards, not simply remove assertions.

## Verification

Tests cover missing/false/malformed legacy opt-ins, disabled legacy API/UI and
unchanged pending records without R2 access. An isolated proposed-config test
copies a synthetic bounded-review plan's two objects, retries exact positions
without copying the next file, and confirms that both legacy start/step and
bounded final start/commit remain disabled, with zero catalog/commit/final-pass
rows. An independent test confirms that an explicitly enabled bounded final
workflow still works with legacy publishing disabled.

The production configuration guard verifies the final write-disabled
configuration, not that every stored file is private. Client tests retain separate confirmations for each
file and now check the copy-only initial status wording. Fixtures are not new
decoder evidence or a signed-in Cloudflare test.

All **546 tests** pass, including actual Vite/Wrangler bundled Worker and local
storage checks. Frontend/Worker lint, normal build and Git whitespace checks
pass. Normal player outputs remain `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB). The eight additional tests cover gate separation.
The full suite also passed again against the actual temporary copy-only
configuration (546/546). After closing writes, all nine selected rollout/gate
tests passed against the final configuration. Lint and the unchanged normal
player build passed before deployment.

## Authorized exact test

The administrator explicitly authorized deployment of copy-only capability and
public copying of these two objects, not catalog publication or any other draft:

- Draft: `405b26f8-fd51-4f82-b3d7-9f676056eb72`, **Lena's Home (batched review check)**.
- Intent: `dd246b49-2cf1-45f5-8d35-a18938986807`.
- Track/version: `9bd4c047-74be-4012-b3ca-41e0cb9dea37` /
  `5bc50912-36f2-4328-80f6-11602a2bddab`.
- Plan SHA-256: `f27960d97b1c2607608ef10011c2e0acdd9cd29e60df1b39eba3755047191fea`.
- Public prefix: `tracks/9bd4c047-74be-4012-b3ca-41e0cb9dea37/versions/5bc50912-36f2-4328-80f6-11602a2bddab/`.
- Planned audio: `audio/Lena's Home.ogg`; planned data: `manifest.json`.

The shared gate enabled bounded-copy capability for eligible administrator-owned
drafts, not a technical one-intent allowlist. The walkthrough stayed limited to
the named test. No other draft was copied under this authorization.

Before copying, read-only cloud checks recovered the unchanged exact intent,
confirmed both copy/final database guards, zero new receipts/final passes and
the unchanged old catalog. Anonymous HEAD requests for both destinations
returned 404. A migration-list request and the first receipt-inspection request
each encountered Cloudflare error 7403; explicit read-only retries succeeded.
No credential/security settings were changed to work around these errors.

The signed-in page showed the copy-only warning, no legacy/final publisher panel
and the same intent at `0/2`. Using the administrator's specific permission, the
agent separately checked the public-exposure statement and clicked **Copy one
object publicly** for audio ordinal 0. The page recorded `1/2`, cleared the
confirmation and did not copy the next file automatically.

Reloading prompted Cloudflare Access sign-in. The computer-use authentication
handoff required the administrator to sign back in personally. Reopening the
same draft and read-only intent refresh recovered `1/2` without replaying the
audio copy. The agent then separately confirmed and copied manifest ordinal 1.
The page recorded `2/2` and locked continuation with catalog publication disabled.
Each copy used independent source/destination/authority checks; expired
preparation checks were not reused as copy permission.

### Exact receipts and public checks

| Object | Bytes | Storage/initial uncompressed HTTP ETag | Receipt recorded (UTC) |
| --- | --- | --- | --- |
| `audio/Lena's Home.ogg` | 3,961,537 | `1fe9a3fa6dbab0a6495594885deca89b` | `2026-10-14T02:21:53.850Z` |
| `manifest.json` | 764 | `4609d2757673550f45311dddd795f0d2` | `2026-10-14T03:07:02.145Z` |

Public GET bytes matched the exact plan's sizes and SHA-256 values:

- Audio: `954d31b74c8c6db4409d673b277b48c887c26d09dcf9f86cd82fc1abfa81f66b`.
- Manifest: `6801e9eb95bdd24e8f14c395d6840d9a1812733bd2b47ae4f9c50809d81d4987`.

Content types are `audio/ogg` and `application/json; charset=utf-8`; both initial
GETs returned `public, max-age=31536000, immutable`. Audio HEAD CORS checks passed
for all six configured live/local origins. A GET for `bytes=0-15` returned 206
and `Content-Range: bytes 0-15/3961537`; that response did not expose an
`Accept-Ranges` header, so no assertion about that header is made. These are
delivery/header checks, not a new decoding or listening test. Bytes were hashed
in memory rather than saved as an extra local audio file.

After disabling writes again, both public HEADs still returned 200. Cloudflare's
later manifest HEAD used a weak `W/` ETag and omitted Content-Length, unlike the
earlier uncompressed GET; byte/hash verification uses the exact GET bytes above,
not the compressed/transformed HEAD representation. Storage receipt identities
match the initial GET ETags (ignoring HTTP quotes).

Read-only D1 confirms two exact new receipts, unchanged intent/hash/state
(`pending`), four total copy receipts, one total catalog commit, one public
track/version, two reviews, zero final passes and valid foreign keys. The old
published intent's state/hash remain unchanged. The public catalog still lists
only that old test. The new version's catalog-backed API returns 404 despite
its R2 audio/manifest URLs being public.

After the write-disabled deployment, reload/reopen/read-only refresh again
recovered the same intent with `2/2` and locked catalog continuation; public-copy,
legacy and final controls are absent. Nothing replayed or resumed. Ignored
screenshot proof: `frontend/.track-manifests/phase7n-copies-locked.jpg` (also
`phase7n-audio-copied.jpg` and `phase7n-copies-complete.jpg`). No credential,
private package/report or screenshot is staged.

## Next gate

Final catalog publication requires a later separately authorized rollout,
independent recent final verification and its own confirmation. Editing existing
published tracks, replacement versions and convenient clip replacement remain
separate planned work, not features completed by this test.

Do not import the original library, change ownership, cut over player loading,
archive/delete test objects or infer catalog-publication permission from the
copy authorization. This real cloud walkthrough covers one audio file, not
a real 129/256-file upload or complete-library migration.
