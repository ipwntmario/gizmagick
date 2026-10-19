// Self-contained: serialized as an explicit dependency of the admin page client.
// This computes an untrusted local edit proposal, never an audio approval.
export function calculateClipEndChanges(manifest, measurements) {
  const errors = [], changes = [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const pointer = key => key.replaceAll('~', '~0').replaceAll('/', '~1');
  const fail = (path, code, message) => errors.push({ path, code, message });
  if (!object(manifest?.clips) || !object(manifest?.assets) || !object(measurements)
      || Object.keys(manifest.clips).length > 2048 || Object.keys(manifest.assets).length > 256
      || Object.keys(measurements).length !== Object.keys(manifest.assets).length) {
    return { changes: [], errors: [{ path: '/', code: 'preparation-input', message: 'A bounded manifest and measurements for every asset are required.' }] };
  }
  for (const [id, asset] of Object.entries(manifest.assets)) {
    const measured = Object.hasOwn(measurements, id) ? measurements[id] : null;
    if (!object(asset) || !object(measured) || !Number.isFinite(measured.durationSeconds) || measured.durationSeconds <= 0 || measured.durationSeconds > 1800
        || !Number.isSafeInteger(measured.byteLength) || measured.byteLength < 1 || measured.byteLength > 16777216
        || typeof measured.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(measured.sha256)
        || (asset.byteLength !== undefined && asset.byteLength !== measured.byteLength)
        || (asset.sha256 !== undefined && asset.sha256 !== measured.sha256)
        || (asset.durationSeconds !== undefined && Math.abs(asset.durationSeconds - measured.durationSeconds) > 0.05)) {
      fail(`/assets/${pointer(id)}`, 'preparation-measurement', 'A complete, source-matching file measurement is required.');
    }
  }
  if (errors.length) return { changes: [], errors };
  for (const [id, clip] of Object.entries(manifest.clips)) {
    const at = `/clips/${pointer(id)}/clipEnd`;
    if (['__proto__', 'prototype', 'constructor'].includes(id) || !object(clip) || !object(clip.assetsByMode)) {
      fail(at, 'preparation-clip', 'A safe clip and its mode assets are required.'); continue;
    }
    const assets = [...new Set(Object.values(clip.assetsByMode))];
    if (!assets.length || assets.some(asset => typeof asset !== 'string' || !Object.hasOwn(manifest.assets, asset))) {
      fail(at, 'preparation-asset', 'Every mode must reference an existing measured asset.'); continue;
    }
    const durations = assets.map(asset => measurements[asset].durationSeconds);
    const shortest = Math.min(...durations), longest = Math.max(...durations);
    // Existing source timings use microseconds. Round upward by at most 1 us
    // rather than making a rounded authored loopPoint exceed its own file end.
    const fileEnd = Math.ceil(shortest * 1e6) / 1e6;
    const missing = !Object.hasOwn(clip, 'clipEnd');
    if (!missing && (!Number.isFinite(clip.clipEnd) || clip.clipEnd <= 0)) {
      fail(at, 'preparation-end', 'clipEnd must be absent or a positive number; null/text/negative values are not defaults.'); continue;
    }
    if (!Number.isFinite(clip.loopStart) || !Number.isFinite(clip.loopPoint) || clip.loopStart < 0 || clip.loopStart >= clip.loopPoint
        || clip.loopPoint > (missing || clip.clipEnd > fileEnd ? fileEnd : clip.clipEnd)) {
      fail(at, 'preparation-loop', 'The endpoint would precede loopPoint. Correct the musical timing; loopPoint is never moved automatically.'); continue;
    }
    if (!missing && clip.clipEnd <= fileEnd) continue; // Keep intentional shorter trims.
    if (longest - shortest > 0.05 + 1e-9) {
      fail(at, 'preparation-mode-lengths', 'Mode files differ by more than 50 ms. Choose an explicit common endpoint instead of guessing which variant to trim.'); continue;
    }
    changes.push({ clipId: id, from: missing ? null : clip.clipEnd, to: fileEnd, reason: missing ? 'missing' : 'too-long' });
  }
  return { changes: errors.length ? [] : changes, errors };
}
