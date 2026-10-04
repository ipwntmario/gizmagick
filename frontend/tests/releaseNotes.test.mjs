import assert from 'node:assert/strict';
import test from 'node:test';
import { LATEST_RELEASE, PREVIOUS_RELEASES, RELEASE_NOTES } from '../src/releaseNotes.js';

test('release notes keep earlier updates in descending version order', () => {
  assert.equal(LATEST_RELEASE, RELEASE_NOTES[0]);
  assert.deepEqual(PREVIOUS_RELEASES, RELEASE_NOTES.slice(1));
  assert.equal(LATEST_RELEASE.version, '0.2.2');
  assert.deepEqual(PREVIOUS_RELEASES.map(({ version }) => version), ['0.2.1', '0.2']);

  const versions = RELEASE_NOTES.map(({ version }) => version.split('.').map(Number));
  for (let index = 1; index < versions.length; index += 1) {
    const [newer, older] = [versions[index - 1], versions[index]];
    assert.ok(newer.some((part, position) => part > (older[position] ?? 0) && newer.slice(0, position).every((earlierPart, earlierPosition) => earlierPart === (older[earlierPosition] ?? 0))));
  }
  for (const release of RELEASE_NOTES) {
    assert.ok(release.intro);
    assert.ok(release.updates.length > 0);
  }
});
