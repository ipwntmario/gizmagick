import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('the bundled Worker verifies signed admin tokens in the actual local Workers runtime', async () => {
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL('../../worker/src/index.js', import.meta.url)), formats: ['es'] } },
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
    bindings: { GIZMAGICK_ACCESS_TEAM_DOMAIN: issuer, GIZMAGICK_ACCESS_AUD: audience,
      GIZMAGICK_ADMIN_ORIGIN: 'https://admin.example.com', GIZMAGICK_ADMIN_EMAILS: 'admin@example.com' },
    outboundService: async req => {
      outbound.push(req.url);
      assert.equal(req.url, `${issuer}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [publicKey] }), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    const token = issue('admin@example.com');
    const request = (path, jwt = token, extra = {}) => mf.dispatchFetch(`https://admin.example.com${path}`, {
      headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}) }, ...extra,
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
    assert.equal(outbound.length, 1);
  } finally { await mf.dispose(); }
});
