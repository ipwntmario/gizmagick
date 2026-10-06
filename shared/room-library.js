import { UUID_PATTERN } from './library-contract.js';

export const ROOM_LIBRARY_PROTOCOL = 'gizmagick-library-v1';
export function validTrackRef(ref) {
  return !!ref && typeof ref === 'object' && typeof ref.trackId === 'string' && typeof ref.versionId === 'string'
    && UUID_PATTERN.test(ref.trackId) && UUID_PATTERN.test(ref.versionId);
}
export function sameTrackRef(a, b) {
  return validTrackRef(a) && validTrackRef(b) && a.trackId === b.trackId && a.versionId === b.versionId;
}
export function trackRefOf(entry) {
  return entry ? { trackId: entry.trackId || entry.id, versionId: entry.versionId } : null;
}
export function trackAssetKey(name, ref) {
  return validTrackRef(ref) ? JSON.stringify([name, ref.trackId, ref.versionId]) : name;
}
