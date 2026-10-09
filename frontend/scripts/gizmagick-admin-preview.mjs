// Isolated UI test harness, NOT a Worker deployment or real Access login.
// Synthetic keys/identity, ephemeral D1/R2, loopback only, no production secrets.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

if (process.argv.length !== 2) throw new Error('This local-only preview accepts no remote/configuration flags.');
const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: true,
  lib: { entry: fileURLToPath(new URL('../../worker/src/index.js', import.meta.url)), formats: ['es'] } } });
const output = Array.isArray(result) ? result[0].output : result.output;
const code = output.find(chunk => chunk.type === 'chunk' && chunk.isEntry).code;
const issuer = 'https://gizmagick-local-preview.cloudflareaccess.com', audience = 'c'.repeat(64);
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'ephemeral-preview', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, aud: [audience], type: 'app',
    sub: '11111111-1111-4111-8111-111111111111', email: 'preview@example.invalid', iat: now - 1, exp: now + 300 })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}
let mf, origin;
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(403); outgoing.end('Loopback preview only'); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    // Credentials are confined to server->local simulator, never sent to the
    // browser. The production Worker still verifies a real RSA-signed token.
    headers.set('Cf-Access-Jwt-Assertion', token());
    // Node fetch replaces Sec-Fetch-Mode with "cors". Miniflare supports this
    // internal forwarding header to preserve the actual browser navigation.
    headers.delete('MF-Sec-Fetch-Mode');
    if (incoming.headers['sec-fetch-mode']) headers.set('MF-Sec-Fetch-Mode', incoming.headers['sec-fetch-mode']);
    const response = await mf.dispatchFetch(new URL(incoming.url, origin).href, { method: incoming.method, headers,
      ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
    for (const [key, value] of response.headers) outgoing.setHeader(key, value);
    outgoing.statusCode = response.status;
    if (response.headers.get('Content-Type')?.startsWith('text/html')) {
      outgoing.end((await response.text()).replace('</header>', '</header><section class="card notice"><p>Local test preview · simulated Access identity · temporary private storage. This is not your production admin session. Data is discarded when this preview stops.</p></section>'));
    } else if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch { outgoing.writeHead(503); outgoing.end('Local preview unavailable'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
origin = `http://127.0.0.1:${server.address().port}`;
try {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: code, cf: false, compatibilityDate: '2024-09-01',
    d1Databases: ['GIZMAGICK_DB'], r2Buckets: ['GIZMAGICK_DRAFTS'],
    bindings: { GIZMAGICK_DRAFT_UPLOADS_ENABLED: 'true', GIZMAGICK_DRAFT_REVIEWS_ENABLED: 'true', GIZMAGICK_DRAFT_METADATA_ENABLED: 'true', GIZMAGICK_ACCESS_TEAM_DOMAIN: issuer,
      GIZMAGICK_ACCESS_AUD: audience, GIZMAGICK_ADMIN_EMAILS: 'preview@example.invalid', GIZMAGICK_ADMIN_ORIGIN: origin },
    outboundService: request => {
      if (request.url !== `${issuer}/cdn-cgi/access/certs`) return new Response(null, { status: 503 });
      return Response.json({ keys: [jwk] });
    },
  }));
  const db = await mf.getD1Database('GIZMAGICK_DB');
  for (const name of ['0001_gizmagick_library.sql', '0002_gizmagick_drafts.sql', '0003_gizmagick_draft_reviews.sql']) {
    const migration = await readFile(new URL(`../../worker/migrations/${name}`, import.meta.url), 'utf8');
    await db.exec(migration.replace(/^--.*$/gm, '').replaceAll('\n', ' '));
  }
  console.log(`Local-only Gizmagick admin preview: ${origin}/admin`);
  console.log('Synthetic identity; ephemeral D1/R2; no production credentials. Do not expose through a tunnel.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    server.closeAllConnections(); server.close(); await mf.dispose(); process.exit(0);
  });
} catch (error) { server.close(); await mf?.dispose(); throw error; }
