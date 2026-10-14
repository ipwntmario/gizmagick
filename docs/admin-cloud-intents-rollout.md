# Phase 7M: Cloudflare publication-plan preparation

Subsequent rollout: [Phase 7N](admin-cloud-copy-rollout.md) now verifies the
separately authorized two public copies for this reserved plan, with no catalog
publication. New public writes are disabled again. The private-only claims and
authorization gate below describe the historical Phase 7M checkpoint.

Deployed October 13, 2026, Eastern. Readiness preparation/checks, the
administrator's separately confirmed immutable reservation and reload recovery
are verified for the privately attested Lena's Home test. No new public file or
catalog entry was created; public-copy and publication flags remain disabled.

## Plain-English rundown

The app can now prepare exactly which reviewed audio and metadata would be
published. It checks the private originals and makes sure the proposed public
locations are unused. Reserving the plan is a separate action: it permanently
locks this exact track/version and plan in D1, but copies no files. Public copying
and final catalog publication remain disabled and require later authorization.
Archiving cannot undo an immutable reservation. Earlier checks are not an atomic
storage snapshot and cannot substitute for fresh checks during later copying
and publication. Existing public files remain public.

## Deployment and safeguards

Worker version: `7ef5c27d-8f3e-4196-b502-1d8d7cf7cc4b`, created
`2026-10-14T00:20:15.003173Z`.

Message: `Phase 7M: enable bounded plan preparation with public writes disabled`.

```toml
GIZMAGICK_PUBLICATION_INTENTS_ENABLED = "true"
GIZMAGICK_BOUNDED_PUBLIC_COPY_ENABLED = "false"
GIZMAGICK_BOUNDED_PUBLICATION_FINAL_ENABLED = "false"
GIZMAGICK_PUBLICATION_ENABLED = "false"
```

Readback confirms these flags, unchanged D1/media/drafts/room bindings and the
existing administrator secret's presence without reading its value. Migrations
0001–0009 are already applied; no migration, Access policy, secret, route, bucket
setting or Pages deployment was changed. The preceding Worker version is
`0835138e-1973-4ce9-9423-bdabac62c8ec`; no rollback was performed.

All **538 tests**, frontend/Worker lint, normal build and whitespace checks pass.
A new test applies the actual intent-only configuration to isolated D1/R2,
records a synthetic batched-review fixture, prepares/checks/reserves its plan,
and confirms zero public writes/catalog rows. Legacy publishing, bounded copying
and final publication requests return 503, and their UI panels are absent. This
is a rollout-specific configuration guard; any future enabling of public writes
must deliberately review/update it. Fixture measurements are not decoder proof.
Normal player outputs remain `index-FinxNOWL.css` (250.25 kB) and
`index-CQBPIrW7.js` (387.48 kB).

## Signed-in cloud readiness walkthrough

The Access session expired on the first post-deployment browser reload. Following
the computer-use authentication handoff, the administrator signed back in. The
new bounded-intent panel appeared, explicitly saying public copying is disabled
and final catalog publication is locked. No legacy/public-copy/final panel was
shown. The existing private attestation remained unchanged.

For **Lena's Home (batched review check)**, the agent used read-only intent refresh,
then explicitly prepared the reviewed plan and checked one readiness batch. The
batch verifies the one private audio source and absence of both proposed public
destinations (audio and manifest); no R2 PUT or audio GET is performed by this
workflow. The page recorded `2/2` proposed objects. Reloading/reopening and using
read-only intent refresh recovered the same preparation/progress without replay.

- Draft: `405b26f8-fd51-4f82-b3d7-9f676056eb72`.
- Track/version: `9bd4c047-74be-4012-b3ca-41e0cb9dea37` /
  `5bc50912-36f2-4328-80f6-11602a2bddab`.
- Preparation: `fe96a214-0fe9-490e-bbef-4bedf45ebbaf`.
- Request: `e08f4c86-cf6d-49cf-b22f-79dd86b191e4`.
- Plan SHA-256: `f27960d97b1c2607608ef10011c2e0acdd9cd29e60df1b39eba3755047191fea`.
- Readiness batch: offset 0 through 2, checked at `1791937313`
  (`2026-10-14T00:21:53.000Z`).
- Preparation expiry: `1791938205` (`2026-10-14T00:36:45.000Z`).

Read-only D1 inspection confirms the exact plan identities, two planned objects
and retained `bounded-batches` review scope. One preparation and one readiness
batch now exist. Immutable publications remain one (the original legacy test),
copy receipts two, commits/tracks/versions one each and reviews two. Foreign-key
checks pass. The public catalog still lists only the original published test
track/version, not this new draft.

At this preparation checkpoint, the agent left reservation unchecked and did not
reserve, copy or publish.
Screenshot proof is ignored `frontend/.track-manifests/phase7m-readiness-handoff.jpg`.
No browser credentials or private package/report files are staged.

## Completed immutable reservation (October 13, 2026, Eastern)

The administrator's first reservation attempt was rejected because the readiness
checks were more than five minutes old. Read-only status confirmed that no intent
had been reserved. The agent explicitly resumed preparation and ran a fresh
readiness batch; this renewed only the unreserved preparation, not the reviewed
audio, metadata or attestation. The stable request and exact plan hash were
unchanged. No raw database write was used to bypass the workflow.

The administrator then personally checked the immutable-reservation statement
and clicked **Reserve immutable intent (no public copies)** within the fresh
check window:

- Renewed preparation/reserved intent: `dd246b49-2cf1-45f5-8d35-a18938986807`.
- Request: `e08f4c86-cf6d-49cf-b22f-79dd86b191e4`.
- Track/version: `9bd4c047-74be-4012-b3ca-41e0cb9dea37` /
  `5bc50912-36f2-4328-80f6-11602a2bddab`.
- Plan SHA-256: `f27960d97b1c2607608ef10011c2e0acdd9cd29e60df1b39eba3755047191fea`.
- Fresh readiness batch: offset 0 through 2, checked at `1791937765`
  (`2026-10-14T00:29:25.000Z`).
- Intent created: `2026-10-14T00:30:02.506Z` (October 13, 8:30 p.m. Eastern),
  about 38 seconds after the readiness batch.
- Plan version: 2; review scope: `bounded-batches`; state: `pending`.
- Planned objects: 2 (audio, then manifest); copy receipts: 0; catalog commits: 0.

Read-only D1 inspection confirms byte-for-byte plan JSON and hash equality
between the retained preparation and immutable intent. Reloading the page,
reopening this draft and using **Refresh intent status (read only)** recovers the
same intent and `0/2` recorded copies. Preparation/restart/check/reserve controls
are locked, and no public-copy or final-publication controls are enabled. The
refresh does not resume work automatically. Screenshot proof is ignored
`frontend/.track-manifests/phase7m-intent-reserved.jpg`.

Overall, D1 now contains two intents: the unchanged original published legacy
test and this new pending version-2 reservation. There is still only one public
track/version, one catalog commit, two original copy receipts and two private
reviews. The old intent's plan/hash/state are unchanged and foreign-key checks
pass. The public catalog contains only the original published test; anonymous
HEAD requests for this new plan's audio and manifest both return 404. No copy
attempt was made and no new public object was written.

This verification checkpoint changes documentation only: no migration,
deployment, configuration, secret, Access policy, audio, metadata or live-player
change. The 538-test/lint/build evidence above belongs to the preceding
implementation checkpoint; no new automated test run is claimed here.

## Next gate

Reservation and reload recovery are complete. Next, review the controlled
public-copy rollout, including the rollout-specific configuration test, and
obtain explicit authorization before enabling copying or exposing either exact
planned object. A reserved intent cannot be replaced, and it is not permission
to copy publicly. Each copy needs independent source/destination checks and its
own confirmation. Final catalog publication remains a separate disabled gate
requiring independent fresh verification and confirmation. Do not enable any
public-write flag as part of this private reservation checkpoint.

This real cloud walkthrough covers one audio file, not a real 129/256-file upload.
Original-library import/ownership mapping, the BleepBloop UglyOnPurpose timing
issue, deployed pinned-room tests, cleanup/user moderation and live-player cutover
remain separate gates. No complete-library migration is claimed.
