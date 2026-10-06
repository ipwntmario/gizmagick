import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAdminAuthenticator } from '../../worker/src/admin-auth.js';
import { createAdminHandler } from '../../worker/src/admin.js';
import worker from '../../worker/src/index.js';

const issuer = 'https://gizmagick-test.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const seconds = 1791295200;
const userId = '11111111-1111-4111-8111-111111111111';
const env = {
  GIZMAGICK_ACCESS_TEAM_DOMAIN: issuer, GIZMAGICK_ACCESS_AUD: audience,
  GIZMAGICK_ADMIN_ORIGIN: 'https://admin.example.com', GIZMAGICK_ADMIN_EMAILS: 'admin@example.com',
};
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const claims = { iss: issuer, aud: [audience], sub: userId, email: 'admin@example.com', type: 'app', iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(payload = {}, header = {}, signer = key.privateKey) {
  const input = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ ...claims, ...payload })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), signer).toString('base64url')}`;
}
function request(token, { path = '/api/admin/session', method = 'GET', headers = {} } = {}) {
  return new Request(`https://admin.example.com${path}`, { method, headers: {
    ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...headers,
  } });
}
function fixture(fetchImpl) {
  const calls = [];
  const authorize = createAdminAuthenticator({ now: () => seconds * 1000, fetchImpl: fetchImpl || (async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ keys: [jwk] });
  }) });
  return { authorize, handle: createAdminHandler(authorize), calls };
}
async function rejects(f, req, config, status, code) {
  await assert.rejects(f.authorize(req, config), error => error.status === status && error.code === code);
}

test('a verified Access app token yields an opaque owner ID; email/room roles are not owner IDs', async () => {
  const f = fixture();
  const admin = await f.authorize(request(jwt()), env);
  assert.match(admin.id, /^access:[a-f0-9]{64}$/);
  assert.equal(admin.email, 'admin@example.com');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.expiresAt, claims.exp);
  const normalized = await f.authorize(request(jwt({ email: 'ADMIN@example.com', role: 'Player' })), { ...env, GIZMAGICK_ADMIN_EMAILS: ' ADMIN@example.com ' });
  assert.equal(admin.id, normalized.id);
  const another = await f.authorize(request(jwt({ sub: '22222222-2222-4222-8222-222222222222' })), env);
  assert.notEqual(admin.id, another.id);
  assert.equal(f.calls.length, 1); // Reuse the bounded remote key cache.
  assert.equal(f.calls[0].url, `${issuer}/cdn-cgi/access/certs`);
  assert.equal(f.calls[0].options.redirect, 'manual');
});

for (const [name, config] of [
  ['missing configuration', {}], ['missing allowlist', { ...env, GIZMAGICK_ADMIN_EMAILS: '' }],
  ['empty allowlist member', { ...env, GIZMAGICK_ADMIN_EMAILS: 'admin@example.com,' }],
  ['invalid email', { ...env, GIZMAGICK_ADMIN_EMAILS: '*' }],
  ['missing audience', { ...env, GIZMAGICK_ACCESS_AUD: '' }],
  ['HTTP issuer', { ...env, GIZMAGICK_ACCESS_TEAM_DOMAIN: 'http://gizmagick-test.cloudflareaccess.com' }],
  ['arbitrary key server', { ...env, GIZMAGICK_ACCESS_TEAM_DOMAIN: 'https://attacker.example.com' }],
  ['issuer URL credentials', { ...env, GIZMAGICK_ACCESS_TEAM_DOMAIN: 'https://x@gizmagick-test.cloudflareaccess.com' }],
  ['issuer path', { ...env, GIZMAGICK_ACCESS_TEAM_DOMAIN: `${issuer}/fake` }],
  ['missing origin', { ...env, GIZMAGICK_ADMIN_ORIGIN: '' }],
  ['public HTTP origin', { ...env, GIZMAGICK_ADMIN_ORIGIN: 'http://admin.example.com' }],
  ['origin path', { ...env, GIZMAGICK_ADMIN_ORIGIN: 'https://admin.example.com/admin' }],
]) test(`admin authentication fails closed with ${name}`, async () => {
  const f = fixture();
  await rejects(f, request(jwt()), config, 503, 'ADMIN_NOT_CONFIGURED');
  assert.equal(f.calls.length, 0);
});

test('unsigned identity headers, cookies, bearer tokens, query flags and Director roles do not sign in', async () => {
  const f = fixture();
  await rejects(f, request(null, { path: '/api/admin/session?admin=true&role=GM', headers: {
    'Cf-Access-Authenticated-User-Email': 'admin@example.com', Authorization: `Bearer ${jwt()}`,
    Cookie: `CF_Authorization=${jwt()}; wizamp.role=GM`, 'X-Admin': 'true',
  } }), env, 401, 'ADMIN_SIGN_IN_REQUIRED');
  assert.equal(f.calls.length, 0);
});

for (const [name, payload] of [
  ['expired token', { exp: seconds }], ['future token', { nbf: seconds + 60 }],
  ['future issuance', { iat: seconds + 60 }], ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
  ['wrong audience', { aud: ['b'.repeat(64)] }], ['global Access session', { type: 'org' }],
  ['service token', { sub: '', email: undefined, common_name: 'service.access' }],
  ['invalid user identifier', { sub: 'admin' }], ['missing expiry', { exp: undefined }],
  ['missing issuance', { iat: undefined }], ['missing token type', { type: undefined }],
  ['explicitly unverified email', { email_verified: false }], ['expiry before issuance', { exp: seconds + 1, iat: seconds + 2 }],
]) test(`rejects ${name}`, async () => {
  await rejects(fixture(), request(jwt(payload)), env, 401, 'ADMIN_INVALID_SESSION');
});

test('signature forgery, algorithm confusion, unknown keys and oversized/malformed tokens are rejected', async () => {
  const f = fixture();
  for (const token of [jwt({}, {}, attacker.privateKey), jwt({}, { kid: 'unknown' }), 'not.a.token', 'x'.repeat(16385),
    `${encode({ alg: 'none' })}.${encode(claims)}.`]) {
    await rejects(f, request(token), env, 401, 'ADMIN_INVALID_SESSION');
  }
  const input = `${encode({ alg: 'HS256', kid: jwk.kid })}.${encode(claims)}`;
  const signature = createHmac('sha256', key.publicKey.export({ type: 'spki', format: 'pem' })).update(input).digest('base64url');
  await rejects(f, request(`${input}.${signature}`), env, 401, 'ADMIN_INVALID_SESSION');
  assert.equal(f.calls.length, 1);
});

test('an authenticated account outside the allowlist cannot promote itself through token roles', async () => {
  const f = fixture();
  await rejects(f, request(jwt({ email: 'member@example.com', role: 'admin', admin: true })), env, 403, 'ADMIN_FORBIDDEN');
});

test('key URLs in token headers never choose the trusted key server', async () => {
  const f = fixture();
  await f.authorize(request(jwt({}, { jku: 'https://evil.example.com/keys', x5u: 'https://evil.example.com/cert', jwk: attacker.publicKey.export({ format: 'jwk' }) })), env);
  assert.deepEqual(f.calls.map(call => call.url), [`${issuer}/cdn-cgi/access/certs`]);
});

test('key-server failures fail closed and expose no upstream details or tokens', async () => {
  for (const fetchImpl of [async () => { throw new TypeError('private upstream error with token'); }, async () => new Response('secret diagnostic', { status: 500 }), async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example.com' } })]) {
    const f = fixture(fetchImpl);
    const response = await f.handle(request(jwt()), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'ADMIN_AUTH_UNAVAILABLE', error: 'Admin sign-in is temporarily unavailable.' });
  }
});

test('unsafe admin requests require the exact admin origin and explicit CSRF header', async () => {
  const f = fixture();
  const token = jwt();
  for (const headers of [{}, { Origin: env.GIZMAGICK_ADMIN_ORIGIN }, { 'X-Gizmagick-Admin-Request': '1' },
    { Origin: 'https://evil.example.com', 'X-Gizmagick-Admin-Request': '1' },
    { Origin: 'null', 'X-Gizmagick-Admin-Request': '1' }]) {
    await rejects(f, request(token, { method: 'POST', headers }), env, 403, 'ADMIN_ORIGIN_REJECTED');
  }
  assert.equal(f.calls.length, 0);
  const authorized = await f.handle(request(token, { method: 'POST', headers: { Origin: env.GIZMAGICK_ADMIN_ORIGIN, 'X-Gizmagick-Admin-Request': '1' } }), env);
  assert.equal(authorized.status, 405); // Authenticated, but writes still disabled.
  assert.equal(authorized.headers.get('Allow'), 'GET, HEAD');
});

test('credentialed cross-origin reads and preflights receive no CORS grants', async () => {
  const f = fixture();
  for (const headers of [{ Origin: 'https://evil.example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await f.handle(request(jwt(), { headers }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  }
  const preflight = await f.handle(request(null, { method: 'OPTIONS', headers: { Origin: env.GIZMAGICK_ADMIN_ORIGIN } }), env);
  assert.equal(preflight.status, 401);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
});

test('a signed-in admin may navigate from the public player or login to the admin page', async () => {
  const f = fixture();
  const response = await f.handle(request(jwt(), { path: '/admin', headers: {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
  } }), env);
  assert.equal(response.status, 200);
  assert((await response.text()).includes('Administrator verified'));
});

test('session endpoint returns only the verified principal, is private/non-cacheable, and supports HEAD', async () => {
  const f = fixture();
  const response = await f.handle(request(jwt()), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.principal.role, 'admin');
  assert.deepEqual(body.capabilities, { uploads: false, publishing: false });
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert(!JSON.stringify(body).includes(jwt()));
  const head = await f.handle(request(jwt(), { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('admin landing page escapes identity data and uses restrictive security headers', async () => {
  const email = "a'<b>@example.com";
  const f = fixture();
  const response = await f.handle(request(jwt({ email }), { path: '/admin' }), { ...env, GIZMAGICK_ADMIN_EMAILS: email });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert(html.includes('Administrator verified'));
  assert(html.includes('a&#39;&lt;b&gt;@example.com'));
  assert(!html.includes(email));
  assert(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  const unavailable = await f.handle(request(null, { path: '/admin' }), {});
  assert.equal(unavailable.status, 503);
  assert((await unavailable.text()).includes('Admin access locked'));
});

test('the admin namespace is gated before routing, including unknown paths and attempted uploads', async () => {
  const f = fixture();
  for (const path of ['/api/admin', '/api/admin/uploads', '/admin/unknown']) {
    const denied = await f.handle(request(null, { path }), env);
    assert.equal(denied.status, 401);
    const unknown = await f.handle(request(jwt(), { path }), env);
    assert.equal(unknown.status, 404);
  }
  assert.equal(await f.handle(request(null, { path: '/api/library/catalog' }), env), null);
  assert.equal(await f.handle(request(null, { path: '/ws' }), env), null);
});

test('Worker routing keeps admin locked without configuration and leaves public health/library routing independent', async () => {
  const locked = await worker.fetch(request(jwt()), {}, {});
  assert.equal(locked.status, 503);
  assert.equal((await locked.json()).code, 'ADMIN_NOT_CONFIGURED');
  const denied = await worker.fetch(request(null), env, {});
  assert.equal(denied.status, 401);
  const health = await worker.fetch(request(null, { path: '/health' }), {}, {});
  assert.deepEqual(await health.json(), { ok: true, worker: 'gizmagick-worker' });
  const catalog = await worker.fetch(request(null, { path: '/api/library/catalog' }), {}, {});
  assert.equal(catalog.status, 503);
  assert.equal((await catalog.json()).error, 'Library is not configured');
});

test('development secrets are ignored and production configuration includes no bypass identity', async () => {
  const ignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert(ignore.includes('worker/.dev.vars\n'));
  const config = await readFile(new URL('../../worker/wrangler.toml', import.meta.url), 'utf8');
  assert(!config.includes('[access.dev]'));
  assert(!config.includes('ADMIN_BYPASS'));
});

test('public WebSocket diagnostics do not log Access JWTs, cookies, or bearer credentials', async () => {
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args);
  try {
    const roomEnv = { ROOM_HUB: { idFromName: () => 'hub', get: () => ({ fetch: async () => new Response('socket stub') }) } };
    await worker.fetch(request('private-jwt', { path: '/ws', headers: {
      Upgrade: 'websocket', Cookie: 'CF_Authorization=private-cookie', Authorization: 'Bearer private-token',
    } }), roomEnv, {});
  } finally { console.log = originalLog; }
  const diagnostic = JSON.stringify(logged);
  assert(!diagnostic.includes('private-jwt'));
  assert(!diagnostic.includes('private-cookie'));
  assert(!diagnostic.includes('private-token'));
});
