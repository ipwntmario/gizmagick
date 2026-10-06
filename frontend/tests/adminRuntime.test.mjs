import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { convertLegacyTrack } from '../scripts/lib/track-manifests.mjs';

test('the bundled Worker verifies signed admin tokens in the actual local Workers runtime', async () => {
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: true, lib: { entry: fileURLToPath(new URL('../../worker/src/index.js', import.meta.url)), formats: ['es'] } },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const code = output.find(chunk => chunk.type === 'chunk' && chunk.isEntry).code;
  const issuer = 'https://gizmagick-runtime-test.cloudflareaccess.com';
  const audience = 'b'.repeat(64);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'runtime-key', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issue = email => {
    const input = `${encode({ alg: 'RS256', kid: publicKey.kid })}.${encode({
      iss: issuer, aud: [audience], sub: '11111111-1111-4111-8111-111111111111',
      email, type: 'app', iat: now - 60, nbf: now - 60, exp: now + 3600,
    })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  };
  const outbound = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: code, cf: false, compatibilityDate: '2024-09-01',
    d1Databases: ['GIZMAGICK_DB'], r2Buckets: ['GIZMAGICK_DRAFTS'],
    bindings: { GIZMAGICK_DRAFT_UPLOADS_ENABLED: 'true', GIZMAGICK_ACCESS_TEAM_DOMAIN: issuer, GIZMAGICK_ACCESS_AUD: audience,
      GIZMAGICK_ADMIN_ORIGIN: 'https://admin.example.com', GIZMAGICK_ADMIN_EMAILS: 'admin@example.com' },
    outboundService: async req => {
      outbound.push(req.url);
      assert.equal(req.url, `${issuer}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [publicKey] }), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    const db = await mf.getD1Database('GIZMAGICK_DB');
    const draftMigration = await readFile(new URL('../../worker/migrations/0002_gizmagick_drafts.sql', import.meta.url), 'utf8');
    // D1 exec() is line-oriented. Each migration is a sequence of SQL statements.
    await db.exec(draftMigration.replace(/^--.*$/gm, '').replaceAll('\n', ' '));
    const token = issue('admin@example.com');
    const request = (path, jwt = token, extra = {}) => mf.dispatchFetch(`https://admin.example.com${path}`, {
      ...extra, headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...extra.headers },
    });
    const allowed = await request('/api/admin/session');
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.principal.email, 'admin@example.com');
    assert.match(body.principal.id, /^access:[a-f0-9]{64}$/);
    const page = await request('/admin');
    assert.equal(page.status, 200);
    assert((await page.text()).includes('Administrator verified'));
    assert.equal((await request('/api/admin/session', null)).status, 401);
    assert.equal((await request('/api/admin/session', issue('member@example.com'))).status, 403);
    assert.equal((await request('/api/admin/session', `${token.slice(0, -20)}invalidsignature`)).status, 401);
    assert.equal((await request('/api/admin/uploads', token, { method: 'POST' })).status, 403);
    assert.equal((await request('/health', null)).status, 200);
    const read = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
    const catalog = await read('../public/trackData.json');
    const track = catalog.tracks["Lena's Home"];
    const manifest = convertLegacyTrack("Lena's Home", track,
      await read(`../public${track.basePath}/clipData.json`), await read(`../public${track.basePath}/sectionData.json`));
    const writeHeaders = { Origin: 'https://admin.example.com', 'X-Gizmagick-Admin-Request': '1', 'Content-Type': 'application/json' };
    const created = await request('/api/admin/drafts', token, { method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ requestId: crypto.randomUUID(), manifest }) });
    assert.equal(created.status, 201, await created.clone().text());
    const draft = await created.json();
    const assetId = Object.keys(draft.manifest.assets)[0];
    const bytes = new Uint8Array(await readFile(new URL(`../public${track.basePath}/${draft.manifest.assets[assetId].path}`, import.meta.url)));
    const uploadUrl = `/api/admin/drafts/${draft.id}/assets/${assetId}`;
    assert.equal((await request(uploadUrl, null, { method: 'PUT', headers: writeHeaders, body: bytes })).status, 401);
    assert.equal((await request(uploadUrl, token, { method: 'PUT', body: bytes })).status, 403);
    const upload = await request(uploadUrl, token, { method: 'PUT', headers: { ...writeHeaders, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal(upload.status, 200, await upload.clone().text());
    assert.equal((await upload.json()).audioProbed, false);
    const download = await request(uploadUrl);
    assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await request(uploadUrl, issue('member@example.com'))).status, 403);
    const resumed = await request(`/api/admin/drafts/${draft.id}`);
    assert.equal((await resumed.json()).missingAssets.length, 0);
    assert.equal((await request('/api/admin/publish', token, { method: 'POST', headers: writeHeaders })).status, 405);
    assert.equal(outbound.length, 1);
  } finally { await mf.dispose(); }
});
