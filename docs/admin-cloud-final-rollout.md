# Phase 7O: prepare final catalog publication on Cloudflare

Prepared October 14, 2026, Eastern. **No final workflow deployment or cloud
publication occurred.** The [Phase 7N test](admin-cloud-copy-rollout.md) still has
two public copies and an unchanged pending intent, but no catalog entry. This
checkpoint adds proposed-configuration regression coverage, corrects misleading
draft-status wording locally and records the explicit authorization gate.

## Plain-English rundown

The audio and manifest are already public files. The next authorized step checks
the private originals and public copies again, then adds this exact track/version
to the database catalog only after separate confirmation. It does not upload the
files again. A successful catalog commit saves its track, version, current-version
pointer and publication audit together; failure rolls those database writes back
together. It does not create a transaction spanning the database and file storage.

This is still the separately named **Lena's Home (batched review check)** test,
not a replacement of the earlier test or an import of the original music library.
Successful publication would make it the second catalog test track. The deployed
player still uses legacy files, so catalog publication alone is not a live-player
cutover and does not change anyone's listening session.

## Code and local verification

The [Phase 7K final workflow](admin-publication-final.md) already implements the
guarded final pass and atomic catalog transaction. No new migration, backend
publisher or storage path is added here. Migration 0009 was applied previously;
do not edit/reapply it.

The new proposed-rollout test starts from an isolated administrator-attested
bounded-review plan with both copy receipts already saved, matching the cloud
test's stage. It then exercises:

- Current write-disabled configuration recovering both copies without R2 access.
- Proposed final flags with legacy publishing still disabled in API, session
  capability and UI; enabling finalization does not enable the legacy publisher.
- Read-only status without writes, and pass preparation recording only D1 check
  state with zero R2 access; a premature commit is rejected before final checks.
- One fresh two-object batch performing one private HEAD and two public HEADs,
  with no audio GET, upload, overwrite or recopy allowed by the fixture.
- Read-only reload-equivalent status and exact batch retries preserving the
  original check timestamps, without silently renewing or repeating checks.
- Missing/false publication or batch-window confirmations rejected before any
  catalog commit, followed by one explicitly confirmed atomic publication.
- Exact commit retry returning the retained result without duplicate entries;
  original review, fixed plan and copy receipts unchanged.
- Restoring disabled write flags while retaining published status and the catalog
  entry; disabling writes does not unpublish previously saved content.

The existing stale/future-window, authority/receipt/lease races, database rollback,
129/256-asset contract and actual bundled Worker/local-storage tests remain in
the full suite. The new proposed-config fixture is not new decoder proof or an
actual signed-in Cloudflare final-verification/publication test.

Draft opening previously keyed two status messages only to the legacy publishing
panel. With legacy off and bounded copying/finalization on, they could incorrectly
say all publishing writes were disabled. The corrected client keeps publication
status unchecked until explicitly refreshed, directs the administrator to the
appropriate intent/final panel and preserves all disabled buttons/confirmations.
The attestation completion message now states that attestation itself copied or
published nothing, without falsely claiming no bounded publisher exists. Two
recent-draft click regressions cover copy-only and final modes with no automatic
publication requests or POSTs. Fully write-disabled wording is unchanged.

All **549 tests** pass, including actual Vite/Wrangler bundled Worker and local
storage checks. Frontend/Worker lint, the normal build and Git whitespace checks
pass. Player output remains `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB). There are three new tests: one proposed final-rollout
integration and two recent-draft status regressions. No actual browser/cloud
final workflow is claimed by these local checks. The client wording correction
has not been deployed yet.

## Read-only cloud readiness

On October 14, read-only D1 queries confirm:

- The exact new intent below is still pending with its original plan SHA-256.
- Its two receipts retain ETags `1fe9a3fa6dbab0a6495594885deca89b` (audio) and
  `4609d2757673550f45311dddd795f0d2` (manifest), with unchanged recorded times.
- There are zero final passes, one total catalog commit and one catalog track.
- The original legacy test remains published with its original plan hash.
- The copy/final guard trigger names are installed and foreign-key checks pass.

Deployment history confirms 100% traffic still uses
`61b343b4-8c53-4d43-94dd-3cdb6b64880d`. Its four public-write switches remain
false. The public catalog still contains only the earlier test. These are
readiness observations, **not** a fresh storage-verification pass or permission
to publish. No R2 object or cloud database record was changed by this checkpoint.

## Proposed configuration and authorization

No flag changes below are applied:

| Flag | Current | Proposed temporary final workflow |
| --- | --- | --- |
| `GIZMAGICK_PUBLICATION_INTENTS_ENABLED` | `true` | `true` |
| `GIZMAGICK_PUBLICATION_ENABLED` | `false` | `true` |
| `GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED` | `false` | `true` |
| `GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED` | `false` | `true` |
| `GIZMAGICK_LEGACY_PUBLICATION_ENABLED` | `false` | `false` |

The existing final capability requires the shared and bounded-copy gates too.
Enabling this combination technically enables copying and finalization for other
eligible administrator-owned drafts, not just one allowlisted intent. Authorization
and the walkthrough must stay limited to the exact test; do not copy any additional
object or act on another draft. The legacy publisher remains disabled.

The final switch enables status, pass preparation, checks **and** the guarded
commit endpoint. It is not a checks-only switch. Even when enabled, no catalog
write runs automatically; the final confirmation is separate. Obtain explicit
administrator permission before deploying these capabilities or publishing:

- Draft: `405b26f8-fd51-4f82-b3d7-9f676056eb72`, **Lena's Home (batched review check)**.
- Intent: `dd246b49-2cf1-45f5-8d35-a18938986807`.
- Track/version: `9bd4c047-74be-4012-b3ca-41e0cb9dea37` /
  `5bc50912-36f2-4328-80f6-11602a2bddab`.
- Plan SHA-256: `f27960d97b1c2607608ef10011c2e0acdd9cd29e60df1b39eba3755047191fea`.

After authorization:

1. Explicitly adapt the actual-configuration guard to the approved final flags,
   rerun tests and deploy the reviewed client/flags. Do not remove guard assertions.
2. Verify active version/flags/bindings/schema. Use the signed-in page to recover
   the exact intent, two receipts and final status without replaying any copy.
   The administrator handles any Access sign-in; do not bypass that gate.
3. Start a new final pass and explicitly check the two planned objects. Status
   reads, old readiness checks and old copy receipts are not new final checks.
4. Confirm publication only with the exact complete pass and checks started at
   most five minutes ago. The pass expires after 15 minutes. Stale checks need an
   explicit new pass; never alter timestamps or use raw D1 writes to bypass it.
   The confirmation accepts separate recent checks, not an atomic storage snapshot.
5. Verify the exact catalog entry/version/pointer/commit/audit, unchanged original
   test, unchanged public files and reload recovery. A lost response requires a
   status read before any separately confirmed retry, not automatic replay.
6. Disable shared/copy/final writes again, restore/test the disabled rollout
   guard and verify locked completion. Keep legacy publishing off throughout.

Expected successful cloud result: two catalog tracks/versions, two completed
publication intents/commits and four existing copy receipts; one retained final
pass for the newly published version-2 test. These are **expected future counts**,
not current cloud state.

No original-library import, ownership remapping, audio replacement, cleanup,
test-object deletion or live Pages/player cutover is authorized by preparation
or by this proposed narrowly scoped catalog test. Existing-track edit drafts and
replacement-version publication remain planned work after this new-track path.
