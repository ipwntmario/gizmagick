// Platform-independent semantics, usable by Node tools and future Worker APIs.
// Call only after structural validation against track-manifest.schema.json.
const owns = (object, key) => Object.hasOwn(object, key);
const pointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

export function validateManifestSemantics(manifest) {
  const errors = [], warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  const warn = (path, code, message) => warnings.push({ path, code, message });
  const { track, assets, clips, sections } = manifest;
  if (!owns(sections, track.firstSection)) {
    error('/track/firstSection', 'missing-section', `Unknown section: ${track.firstSection}`);
  }
  const paths = new Set(), usedAssets = new Set(), memberClips = new Set();
  for (const [id, asset] of Object.entries(assets)) {
    const path = `/assets/${pointer(id)}/path`;
    if (asset.path.slice(6).startsWith('.')) error(path, 'unsafe-path', 'Audio filenames must not start with a dot.');
    if (paths.has(asset.path)) error(path, 'duplicate-asset-path', 'Define a physical file once and reuse its asset ID.');
    paths.add(asset.path);
  }
  for (const [id, clip] of Object.entries(clips)) {
    const path = `/clips/${pointer(id)}`;
    if (!(clip.loopStart < clip.loopPoint && clip.loopPoint <= clip.clipEnd)) {
      error(path, 'invalid-timing', 'Require 0 <= loopStart < loopPoint <= clipEnd; equality at clipEnd is valid.');
    }
    for (const [mode, assetId] of Object.entries(clip.assetsByMode)) {
      usedAssets.add(assetId);
      if (!owns(assets, assetId)) error(`${path}/assetsByMode/${pointer(mode)}`, 'missing-asset', `Unknown asset: ${assetId}`);
      else if (assets[assetId].durationSeconds !== undefined && clip.clipEnd > assets[assetId].durationSeconds + 0.05) {
        error(`${path}/clipEnd`, 'past-audio-end', `clipEnd exceeds measured duration for ${assetId} (50 ms tolerance).`);
      }
    }
    const targets = new Set();
    let total = 0;
    for (const [index, transition] of clip.transitions.entries()) {
      total += transition.weight;
      if (!owns(clips, transition.to)) error(`${path}/transitions/${index}/to`, 'missing-clip', `Unknown clip: ${transition.to}`);
      if (targets.has(transition.to)) error(`${path}/transitions/${index}/to`, 'duplicate-transition', 'Use one weighted entry per target.');
      targets.add(transition.to);
    }
    if (total > 4096) error(`${path}/transitions`, 'weight-limit', 'Total transition weight must not exceed 4096.');
  }
  for (const [id, section] of Object.entries(sections)) {
    const path = `/sections/${pointer(id)}`;
    if (!owns(clips, section.firstClip)) error(`${path}/firstClip`, 'missing-clip', `Unknown clip: ${section.firstClip}`);
    if (!section.clips.includes(section.firstClip)) error(`${path}/clips`, 'missing-entry-member', 'Section clips must include its firstClip.');
    if (section.modes.includes('base')) error(`${path}/modes`, 'reserved-base-mode', 'Base is implicit; list only additional modes.');
    if (section.type === 'auto' && section.nextSections.length !== 1) error(`${path}/nextSections`, 'auto-target-count', 'An auto section requires exactly one next section.');
    if (section.type === 'end' && section.nextSections.length) error(`${path}/nextSections`, 'end-targets', 'End sections must not have next sections.');
    for (const target of section.nextSections) {
      if (!owns(sections, target)) error(`${path}/nextSections`, 'missing-section', `Unknown section: ${target}`);
    }
    const members = new Set(section.clips);
    for (const clipId of members) {
      memberClips.add(clipId);
      if (!owns(clips, clipId)) {
        error(`${path}/clips`, 'missing-clip', `Unknown clip: ${clipId}`);
        continue;
      }
      for (const { to } of clips[clipId].transitions) {
        if (!members.has(to)) error(`${path}/clips`, 'transition-outside-section', `${clipId} transitions to ${to}, which must also be listed in this section. Use nextSections to change section.`);
      }
      for (const mode of section.modes) {
        if (!owns(clips[clipId].assetsByMode, mode)) warn(`${path}/modes`, 'base-mode-fallback', `${clipId} has no ${mode} variant; playback uses base.`);
      }
    }
    const reachable = walk(section.firstClip, id => clips[id]?.transitions.map(t => t.to) || []);
    if (section.type === 'auto' && ![...reachable].some(clipId => clips[clipId]?.transitions.some(t => t.to === clipId))) {
      error(path, 'missing-auto-boundary', 'An auto section needs a reachable self-loop clip to trigger the current engine\'s section handoff.');
    }
    for (const clipId of members) {
      if (!reachable.has(clipId)) warn(`${path}/clips`, 'unreachable-member', `${clipId} is not reachable from this section's firstClip.`);
    }
    if (section.type === 'end') {
      // End paths must actually terminate; ordinary section/clip loops are valid.
      const terminating = new Set([...reachable].filter(id => clips[id]?.transitions.length === 0));
      let changed = true;
      while (changed) {
        changed = false;
        for (const clipId of reachable) {
          const transitions = clips[clipId]?.transitions;
          if (!terminating.has(clipId) && transitions?.length && transitions.every(t => terminating.has(t.to))) {
            terminating.add(clipId);
            changed = true;
          }
        }
      }
      if (!terminating.has(section.firstClip)) error(path, 'nonterminating-end', 'Every path through an end section must terminate; cycles belong in manual/auto sections.');
    }
  }
  const reachableSections = walk(track.firstSection, id => sections[id]?.nextSections || []);
  for (const id of Object.keys(sections)) {
    if (!reachableSections.has(id)) warn(`/sections/${pointer(id)}`, 'unreachable-section', 'No declared section path reaches this section from firstSection.');
  }
  for (const id of Object.keys(clips)) {
    if (!memberClips.has(id)) warn(`/clips/${pointer(id)}`, 'unused-clip', 'Clip is not listed in any section.');
  }
  for (const id of Object.keys(assets)) {
    if (!usedAssets.has(id)) warn(`/assets/${pointer(id)}`, 'unused-asset', 'Asset is not referenced by any clip.');
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function walk(start, next) {
  const visited = new Set(), pending = [start];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...next(id).filter(target => !visited.has(target)));
  }
  return visited;
}

// Bridge to the existing engine. Validate first. Preserves seeded RNG behavior:
// the engine sorts the expanded choices and draws only when length >= 2.
export function manifestToEngineData(manifest) {
  const clips = Object.fromEntries(Object.entries(manifest.clips).map(([id, clip]) => [id, {
    file: Object.fromEntries(Object.entries(clip.assetsByMode).map(([mode, assetId]) => [mode, manifest.assets[assetId].path.slice(6)])),
    loopStart: clip.loopStart,
    loopPoint: clip.loopPoint,
    clipEnd: clip.clipEnd,
    nextClip: clip.transitions.flatMap(({ to, weight }) => Array(weight).fill(to)),
  }]));
  const sections = Object.fromEntries(Object.entries(manifest.sections).map(([id, section]) => [id, {
    defaultDisplayName: section.title,
    ...(section.buttonLabel !== undefined ? { defaultButtonName: section.buttonLabel } : {}),
    ...(section.baseModeLabel !== undefined ? { defaultBaseModeName: section.baseModeLabel } : {}),
    firstClip: section.firstClip,
    type: section.type === 'manual' ? '' : section.type,
    nextSection: section.type === 'auto' ? section.nextSections[0] : section.nextSections,
    modes: section.modes,
  }]));
  return { clips, sections };
}
