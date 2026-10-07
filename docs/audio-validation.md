# Phase 6C: local admin audio validation

The administrator chose free local validation first. This increment implements
the decoder and timing-validation foundation, **not cloud attestation or
publication**. It adds no paid service, production binding, remote migration,
or deployment. No music or legacy JSON is rewritten.

From `frontend`, after `npm ci`, run:

```powershell
npm run tracks:probe -- --track "Lena's Home"
npm run tracks:probe -- --track "Testing Time"
```

To check a downloaded/private draft manifest instead, arrange its exact audio
files under an `audio/` subdirectory and run:

```powershell
npm run tracks:probe -- --manifest "C:/path/to/draft-manifest.json" --track-root "C:/path/to/track"
```

The CLI prints a JSON report and returns exit code 0 only when every required
file and the measured manifest pass. Invalid audio/timing returns 1; invalid
arguments or unreadable metadata return 1 with an error on stderr. To consume
pure JSON programmatically without npm's command banner, invoke
`node scripts/gizmagick-audio-probe.mjs` with the same arguments. There is no
`--publish`, cloud upload, token, or automatic output-file option.

## Checks and limits

- Existing canonical structural/graph validation, including every mode asset.
- Complete Ogg framing, per-page CRC, stream identity, consecutive page numbers,
  packet continuations, monotonic sample positions, and a terminal EOS page.
- Actual full-stream decoding through pinned `@wasm-audio-decoders/ogg-vorbis`
  0.1.20 and `ogg-opus-decoder` 1.7.5. Any reported decode error fails the file;
  measurements are not guessed from a duration tag or identification header.
- Returned channel count/sample rate, finite PCM, decoded sample count, and
  consistency with container timing. Streams must be mono/stereo Vorbis at
  8–96 kHz, or mono/stereo version-1 Opus with mapping family zero at 48 kHz.
  Chained/multiplexed streams and partial broadcast captures are not supported.
- Actual file byte length and SHA-256; supplied fingerprints must match. A
  supplied duration must agree within 50 ms. All `clipEnd` values must fit every
  referenced mode's measured duration, using the existing 50 ms tolerance.
- Metadata: 256 KiB, 256 assets, 2,048 clips, 128 sections. Audio: 16 MiB/file,
  256 MiB/track, 30 minutes/file, 256 KiB/packet, 65,536 pages/file.
- Decoding runs sequentially in a separate Node worker thread with a 30-second
  wall-clock deadline per file and a two-minute aggregate decode budget per
  track. Timeout/error/success all terminate the thread. PCM is discarded after
  bounded input chunks rather than retaining a decoded track.
- Audio paths are resolved and constrained to the selected track root, including
  symlinks/junctions. Regular-file reads are bounded and reject size changes.

Node's worker-thread heap limits are useful resource controls, **not an OS
sandbox or a total-process memory guarantee**; WebAssembly/external buffers are
not covered by the JavaScript heap ceiling. This is an administrator-run local
tool, not a hardened public upload processing service or malware scanner.

Vorbis's startup overlap requires care: for some existing streams the pinned
decoder returns exactly half a short block fewer samples than the container's
final position (128 samples for the tested files). The validator permits only
zero or that exact header-derived difference, records both sample counts and
the difference, and derives duration from returned PCM. It never pads missing
audio or substitutes a claimed container duration for decoded samples.
[Vorbis encapsulation/timing specification](https://xiph.org/vorbis/doc/Vorbis_I_spec.html),
[decoder project](https://github.com/eshaz/wasm-audio-decoders).

The decoder packages are pinned dev-only dependencies. Their dependency tree
includes `codec-parser` under LGPL-3.0-or-later; no decoder code is imported into
the production player or Cloudflare Worker. Preserve package notices when
distributing tooling. The npm audit performed during this increment reports no
advisories against the new decoder dependencies, but five high-severity entries
in the pre-existing development-tool chain (`miniflare`, `wrangler`, `sharp`,
`undici`, and `source-map-js`). No automatic/breaking audit upgrades were applied.
Review those separately before exposing any development tooling.

## What the report means

The original `--track`/`--manifest` reports carry `scope: "local-only"`,
`publishing: false`, input track/version IDs,
an input-manifest SHA-256, decoder versions, limits, per-asset measured
fingerprints/durations, graph warnings/errors, and an `enrichedManifest` only on
complete success. The input manifest is unchanged.

The enriched document is a **review candidate**, not a new published immutable
version. It retains the input IDs to associate the report with that draft;
publication must later assign/record the appropriate immutable version and
verify the exact stored bytes. Do not overwrite existing exports or publish a
candidate by hand.

An unsigned report—even one containing a checksum—is **not proof to the server**
that a trusted decoder ran. There is intentionally no report-import endpoint,
client-controlled `audioProbed` flag, or privileged trust secret in this step.
The deployed admin draft remains **NOT audio-probed / NOT published**. A
successful probe of repository files does not certify a cloud draft just because
its title matches; its manifest/version and every stored audio fingerprint must
be bound to any later approval.

Cloudflare Workers Free currently allows 10 ms CPU/request with 128 MB memory;
full-track decoding is not an appropriate synchronous upload-endpoint workload.
The local-first choice avoids introducing another service or paid compute.
[Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## Verification record

The local catalog sweep checked all 13 tracks and their 176 asset references
(including copies shared across the BleepBloop test tracks):

- 12 tracks pass decoded-duration and graph checks, including Lena's Home and
  all 129 assets of the dynamic Testing Time track.
- Lena's Home: 8,640,000 samples, 180 seconds, stereo Opus at 48 kHz,
  3,961,537 bytes. Its SHA-256 matches the previously uploaded private smoke
  test's fingerprint; the cloud draft's trust status was not changed.
- `BleepBloop UglyOnPurpose` (already a test track) fails as expected by the
  new duration check: `Main_a.clipEnd` is 16.153855 seconds, while
  `audio/Main_aTEST.ogg` decodes to 13.846167800453514 seconds. This is a recorded
  discrepancy, not an assertion that the author's intent was incorrect. The
  existing file/data was left untouched.

Tests include real Opus/Vorbis files, the entire Testing Time manifest, a truly
decodable 20 ms Opus fixture, CRC-valid invalid codec data, damaged/truncated
pages, missing EOS, chained/foreign streams, sequence/continuation errors,
forged longer duration, byte/time limits, stale metadata, missing files,
junction path escape, CLI exit codes, and parent-only Node flag isolation.
The existing Worker authentication/storage regression tests remain in place.
All **197 automated tests**, lint, and the normal frontend build pass. The
frontend build's emitted asset names/sizes match the prior checkpoint; the
local decoder dependencies do not enter its production bundle.

## Next checkpoint

The [Phase 6D administrator review implementation](admin-review.md) now connects
this runner to an exact draft/package snapshot with `--review-package` and an
explicit personal-run confirmation. It records human provenance under verified
admin identity, **not cryptographic proof of decoder execution**. Ordinary
`local-only` reports remain ineligible; the server neither accepts those as
trusted measurements nor flips `audioProbed`. This subsequent feature is tested
locally and disabled in cloud pending migration 0003 and rollout verification.
Immutable publication and staged import remain later work. A future automated
decoder needs a separate trust boundary and resource/retention policy; browser
decoding alone cannot replace it.

Commit this local foundation on the feature branch with a message such as
`feat: add local audio decoding and timing validation`. Do not stage generated
reports, screenshots, music, or secrets. Main and live production remain unchanged.
