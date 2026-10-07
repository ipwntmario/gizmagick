import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { convertLegacyTrack } from '../scripts/lib/track-manifests.mjs';
import { REVIEW_POLICY } from '../../shared/draft-review.js';

async function bundledWorker(packager) {
  if (packager === 'wrangler') {
    const directory = await mkdtemp(join(tmpdir(), 'gizmagick-admin-test-'));
    try {
      await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
        'deploy', '--dry-run', '--outdir', directory, '--config',
        fileURLToPath(new URL('../../worker/wrangler.toml', import.meta.url)),
      ], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60000 });
      return await readFile(join(directory, 'index.js'), 'utf8');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: { write: false, minify: true, lib: { entry: fileURLToPath(new URL('../../worker/src/index.js', import.meta.url)), formats: ['es'] } },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  return output.find(chunk => chunk.type === 'chunk' && chunk.isEntry).code;
}

async function verifyBrowserInitialization(html) {
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', disabled: false, listeners: new Map(),
      addEventListener(event, callback) { this.listeners.set(event, callback); },
      replaceChildren() {},
    });
    return elements.get(id);
  };
  const calls = [];
  // Execute the emitted page script, not its unbundled source. Browser globals
  // are explicit; no Worker/esbuild helpers are available in this fresh realm.
  runInNewContext(scripts[0][1], {
    document: { getElementById: element, querySelectorAll: () => [] },
    fetch: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, redirected: false, headers: { get: () => 'application/json' }, json: async () => ({ drafts: [] }) };
    },
  }, { timeout: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('status').textContent, 'Private draft intake is ready. Publishing is disabled.');
  assert.equal(element('draft-list').textContent, 'No drafts yet.');
  assert.equal(element('upload').disabled, true);
  assert.equal(element('archive').disabled, true);
  assert.equal(element('review-package').disabled, true);
  assert.equal(element('attest-review').disabled, true);
  assert(element('sections-file').listeners.has('change'));
  assert(element('create-draft').listeners.has('submit'));
  assert(element('audio-files').listeners.has('change'));
  assert(element('upload').listeners.has('click'));
  assert(element('review-report').listeners.has('change'));
  assert(element('attest-review').listeners.has('click'));
  assert.deepEqual(calls.map(call => [call.path, call.options.method]), [['/api/admin/drafts', 'GET']]);
}

for (const packager of ['vite', 'wrangler']) test(`the ${packager}-bundled Worker verifies tokens, boots its browser script, and stores private audio`, async () => {
  const code = await bundledWorker(packager);
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
    bindings: { GIZMAGICK_DRAFT_UPLOADS_ENABLED: 'true', GIZMAGICK_DRAFT_REVIEWS_ENABLED: 'true', GIZMAGICK_ACCESS_TEAM_DOMAIN: issuer, GIZMAGICK_ACCESS_AUD: audience,
      GIZMAGICK_ADMIN_ORIGIN: 'https://admin.example.com', GIZMAGICK_ADMIN_EMAILS: 'admin@example.com' },
    outboundService: async req => {
      outbound.push(req.url);
      assert.equal(req.url, `${issuer}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [publicKey] }), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  try {
    const db = await mf.getD1Database('GIZMAGICK_DB');
    // D1 exec() is line-oriented. Each migration is a sequence of SQL statements.
    for (const name of ['0002_gizmagick_drafts.sql', '0003_gizmagick_draft_reviews.sql']) {
      const migration = await readFile(new URL(`../../worker/migrations/${name}`, import.meta.url), 'utf8');
      await db.exec(migration.replace(/^--.*$/gm, '').replaceAll('\n', ' '));
    }
    const token = issue('admin@example.com');
    const request = (path, jwt = token, extra = {}) => mf.dispatchFetch(`https://admin.example.com${path}`, {
      ...extra, headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...extra.headers },
    });
    const allowed = await request('/api/admin/session');
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.principal.email, 'admin@example.com');
    assert.equal(body.capabilities.reviews, true);
    assert.match(body.principal.id, /^access:[a-f0-9]{64}$/);
    const page = await request('/admin');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert(html.includes('Administrator verified'));
    await verifyBrowserInitialization(html);
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
    const packageUrl = `/api/admin/drafts/${draft.id}/review-package`;
    assert.equal((await request(packageUrl, null, { method: 'POST', headers: writeHeaders })).status, 401);
    assert.equal((await request(packageUrl, token, { method: 'POST' })).status, 403);
    assert.equal((await request(packageUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders })).status, 403);
    const jobResponse = await request(packageUrl, token, { method: 'POST', headers: writeHeaders });
    assert.equal(jobResponse.status, 200, await jobResponse.clone().text());
    const job = await jobResponse.json();
    assert.equal(job.snapshot.assets[0].byteLength, bytes.length);
    // Run the actual local CLI against a package minted by the actual bundled
    // Worker and R2/D1 simulator, not a fabricated report or bypassed handler.
    const directory = await mkdtemp(join(tmpdir(), 'gizmagick-review-cli-'));
    let report;
    try {
      const packageFile = join(directory, 'review-package.json');
      await writeFile(packageFile, JSON.stringify(job));
      const cli = fileURLToPath(new URL('../scripts/gizmagick-audio-probe.mjs', import.meta.url));
      const trackRoot = fileURLToPath(new URL(`../public${track.basePath}/`, import.meta.url));
      const args = [cli, '--review-package', packageFile, '--track-root', trackRoot];
      const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 30000 });
      report = JSON.parse(stdout);
      assert.equal(report.valid, true); assert.equal(report.draftId, draft.id);
      await writeFile(packageFile, JSON.stringify({ ...job, expiresAt: 0 }));
      await assert.rejects(promisify(execFile)(process.execPath, args), error => error.code === 1 && error.stderr.includes('expired'));
      const altered = structuredClone(job); altered.snapshot.manifest.track.title += '!';
      await writeFile(packageFile, JSON.stringify(altered));
      await assert.rejects(promisify(execFile)(process.execPath, args), error => error.code === 1 && error.stderr.includes('altered'));
    } finally { await rm(directory, { recursive: true, force: true }); }
    const attestUrl = `/api/admin/drafts/${draft.id}/attest-review`;
    const bodyForReview = JSON.stringify({ report, policy: REVIEW_POLICY, provenanceConfirmed: true });
    assert.equal((await request(attestUrl, null, { method: 'POST', headers: writeHeaders, body: bodyForReview })).status, 401);
    assert.equal((await request(attestUrl, token, { method: 'POST', body: bodyForReview })).status, 403);
    assert.equal((await request(attestUrl, token, { method: 'POST', headers: { ...writeHeaders, Origin: 'https://evil.example.com' }, body: bodyForReview })).status, 403);
    assert.equal((await request(attestUrl, issue('member@example.com'), { method: 'POST', headers: writeHeaders, body: bodyForReview })).status, 403);
    const approved = await request(attestUrl, token, { method: 'POST', headers: writeHeaders, body: bodyForReview });
    assert.equal(approved.status, 201, await approved.clone().text());
    const approvedBody = await approved.json();
    assert.equal(approvedBody.review.scope, 'administrator-attested');
    assert.equal(approvedBody.review.serverDecoded, false); assert.equal(approvedBody.publishing, false);
    const reopened = await (await request(`/api/admin/drafts/${draft.id}`)).json();
    assert.equal(reopened.review.reportSha256, approvedBody.review.reportSha256);
    assert.equal(reopened.audioProbed, false);
    assert.equal((await request(attestUrl, token, { method: 'POST', headers: writeHeaders, body: bodyForReview })).status, 200);
    assert.equal((await request('/api/admin/publish', token, { method: 'POST', headers: writeHeaders })).status, 405);
    assert.equal(outbound.length, 1);
  } finally { await mf.dispose(); }
});
