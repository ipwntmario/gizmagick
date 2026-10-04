export function heldStopFadeSeconds(configuredSeconds) {
  const seconds = Math.max(0, Number(configuredSeconds) || 0);
  return seconds > 1 ? 0.5 : seconds / 2;
}
