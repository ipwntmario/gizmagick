export function trackTitle(name, track, names) {
  return names?.tracks?.[name]?.displayName ?? track?.defaultDisplayName ?? name;
}

export const DEFAULT_TRACK_FILTERS = { dynamic: true, simple: true, tests: 'all' };

export function activeTrackFilterCount(filters) {
  return Number(!filters.dynamic) + Number(!filters.simple) + Number(filters.tests !== 'all');
}

export function normalizeTrackFilters(value) {
  return {
    dynamic: typeof value?.dynamic === 'boolean' ? value.dynamic : true,
    simple: typeof value?.simple === 'boolean' ? value.simple : true,
    tests: ['all', 'exclude', 'only'].includes(value?.tests) ? value.tests : 'all',
  };
}

export function orderTracks(tracks, { sortMode, filters, pinned, names, durations }) {
  const selected = normalizeTrackFilters(filters);
  return Object.entries(tracks || {})
    .filter(([, track]) => (
      (track.simple === false ? selected.dynamic : selected.simple)
      && (selected.tests === 'all' || (selected.tests === 'only' ? track.test === true : track.test !== true))
    ))
    .sort(([a, ta], [b, tb]) => {
      const pinOrder = Number(!!pinned?.has(b)) - Number(!!pinned?.has(a));
      const titleOrder = trackTitle(a, ta, names).localeCompare(trackTitle(b, tb, names));
      if (pinOrder) return pinOrder;
      if (sortMode === 'duration-asc' || sortMode === 'duration-desc') {
        const aDuration = durations?.[a];
        const bDuration = durations?.[b];
        if (aDuration == null && bDuration != null) return 1;
        if (bDuration == null && aDuration != null) return -1;
        const durationOrder = (aDuration ?? 0) - (bDuration ?? 0);
        return durationOrder * (sortMode === 'duration-desc' ? -1 : 1) || titleOrder;
      }
      return titleOrder * (sortMode === 'alpha-desc' ? -1 : 1);
    }).map(([name]) => name);
}
