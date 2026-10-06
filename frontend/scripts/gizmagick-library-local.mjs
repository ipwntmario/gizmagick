import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createLocalLibrarySnapshot } from './lib/gizmagick-local-library.mjs';
import { seedLocalLibrary } from './lib/gizmagick-local-seed.mjs';

if (process.argv.length > 2) throw new Error('This command is local-only and accepts no remote flags.');
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const config = await readFile(new URL('../../worker/wrangler.toml', import.meta.url), 'utf8');
function bindingValue(section, binding, field) {
  const blocks = config.split(`[[${section}]]`).slice(1).map(block => block.split(/\r?\n\[/)[0]);
  const block = blocks.find(value => new RegExp(`binding\\s*=\\s*"${binding}"`).test(value));
  const value = block?.match(new RegExp(`${field}\\s*=\\s*"([^"\\r\\n]+)"`))?.[1];
  if (!value) throw new Error(`Missing ${binding}.${field} in worker/wrangler.toml`);
  return value;
}
const snapshot = await createLocalLibrarySnapshot(publicRoot);
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: 'export default { fetch() { return new Response("Local Gizmagick seed"); } }',
  cf: false,
  resourcePersistencePath: fileURLToPath(new URL('../../worker/.wrangler/state/v3/', import.meta.url)),
  d1Databases: { GIZMAGICK_DB: bindingValue('d1_databases', 'GIZMAGICK_DB', 'database_id') },
  r2Buckets: { GIZMAGICK_MEDIA: bindingValue('r2_buckets', 'GIZMAGICK_MEDIA', 'bucket_name') },
}));
try {
  console.log('Seeding LOCAL D1/R2 only. No Cloudflare uploads or deployments. Stop local Worker sessions first.');
  const db = await mf.getD1Database('GIZMAGICK_DB');
  try { await db.prepare('SELECT id FROM library_tracks LIMIT 1').all(); }
  catch { throw new Error('Apply npm run library:migrate:local before seeding.'); }
  const result = await seedLocalLibrary({ db, bucket: await mf.getR2Bucket('GIZMAGICK_MEDIA'), snapshot, publicRoot, onTrack: name => console.log(`Ready locally: ${name}`) });
  console.log(JSON.stringify(result));
} finally {
  await mf.dispose();
}
