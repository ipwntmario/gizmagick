export function trackDurationSeconds(track, clips) {
  const entries = Object.values(clips || {});
  if (!entries.length) return null;

  if (track?.simple === false) {
    const seconds = entries.reduce((total, clip) => {
      const loopPoint = Number(clip?.loopPoint);
      const files = clip?.file;
      const variantCount = files && typeof files === "object"
        ? Object.values(files).filter(Boolean).length
        : 1;
      return total + (Number.isFinite(loopPoint) && loopPoint > 0 ? loopPoint * variantCount : 0);
    }, 0);
    return seconds > 0 ? seconds : null;
  }

  const clip = entries[0];
  const seconds = Number(clip?.clipEnd ?? clip?.loopPoint);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function formatTrackDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = String(rounded % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
