// Fixtures for the loopback-only ephemeral simulator, never a cloud seeder.
// Uses normal guarded Worker APIs and the pinned decoder; never inserts reviews
// directly or creates a publication intent/copy/catalog pointer.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { convertLegacyTrack } from './track-manifests.mjs';
import { probeManifest, createProbeReport } from './audio-probe.mjs';
import { createReviewReport, REVIEW_POLICY } from '../../../shared/draft-review.js';

export async function seedPublicationPreview(request) {
  const read = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
  const catalog = await read('../../public/trackData.json'), track = catalog.tracks["Lena's Home"];
  const manifest = convertLegacyTrack("Lena's Home (local publication preview)", track,
    await read(`../../public${track.basePath}/clipData.json`), await read(`../../public${track.basePath}/sectionData.json`));
  manifest.track.title = "Lena's Home (local publication preview)";
  const draft = await request('/api/admin/drafts', 'POST', { requestId: crypto.randomUUID(), manifest });
  for (const [id, asset] of Object.entries(draft.manifest.assets)) {
    const bytes = new Uint8Array(await readFile(new URL(`../../public${track.basePath}/${asset.path}`, import.meta.url)));
    await request(`/api/admin/drafts/${draft.id}/assets/${id}`, 'PUT', bytes);
  }
  const job = await request(`/api/admin/drafts/${draft.id}/review-package`, 'POST');
  const measured = await probeManifest(job.snapshot.manifest, fileURLToPath(new URL(`../../public${track.basePath}/`, import.meta.url)));
  if (!measured.valid) throw new Error('Local publication fixture failed real audio validation.');
  const report = await createReviewReport(job, createProbeReport(job.snapshot.manifest, measured));
  await request(`/api/admin/drafts/${draft.id}/attest-review`, 'POST', { report, policy: REVIEW_POLICY, provenanceConfirmed: true });
  return draft.id;
}
