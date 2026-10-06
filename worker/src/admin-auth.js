import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { UUID_PATTERN } from '../../shared/library-contract.js';

export class AdminAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new AdminAuthError(status, code, message); };
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(value) && value.length <= 254;

function configuration(env) {
  // Only configuration chooses the key server. Never read iss/jku/x5u from an
  // unverified token to choose a URL, or fall back to a development identity.
  const issuer = typeof env.GIZMAGICK_ACCESS_TEAM_DOMAIN === 'string' ? env.GIZMAGICK_ACCESS_TEAM_DOMAIN.replace(/\/$/, '') : '';
  const audience = env.GIZMAGICK_ACCESS_AUD;
  const emails = typeof env.GIZMAGICK_ADMIN_EMAILS === 'string' ? env.GIZMAGICK_ADMIN_EMAILS.split(',').map(normalizeEmail) : [];
  let origin;
  try {
    const url = new URL(env.GIZMAGICK_ADMIN_ORIGIN);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error();
    origin = url.origin;
  } catch { /* handled below */ }
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)
      || typeof audience !== 'string' || !/^[a-f0-9]{64}$/i.test(audience)
      || !origin || !emails.length || emails.some(email => !validEmail(email))) {
    fail(503, 'ADMIN_NOT_CONFIGURED', 'Admin sign-in has not been configured.');
  }
  return { issuer, audience, emails, origin };
}

// The factory permits isolated signed-token tests. Production uses the default
// fetch and clock; no environment variable enables mocks, bypasses or test keys.
export function createAdminAuthenticator({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let keyIssuer, keys;
  return async function requireAdmin(request, env) {
    const config = configuration(env);
    const origin = request.headers.get('Origin');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    // A top-level link from the public player or Access login may legitimately
    // arrive cross-site. Credentialed fetches and unsafe navigation are not.
    const navigation = ['GET', 'HEAD'].includes(request.method)
      && request.headers.get('Sec-Fetch-Mode') === 'navigate' && request.headers.get('Sec-Fetch-Dest') === 'document';
    if ((origin && origin !== config.origin) || (request.headers.get('Sec-Fetch-Site') === 'cross-site' && !navigation)
        || (unsafe && (origin !== config.origin || request.headers.get('X-Gizmagick-Admin-Request') !== '1'))) {
      fail(403, 'ADMIN_ORIGIN_REJECTED', 'Admin requests must come from the configured admin site.');
    }
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) fail(401, 'ADMIN_SIGN_IN_REQUIRED', 'Sign in through Cloudflare Access to continue.');
    if (token.length > 16384) fail(401, 'ADMIN_INVALID_SESSION', 'Admin session is invalid or expired.');
    if (keyIssuer !== config.issuer) {
      keyIssuer = config.issuer;
      keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
        [customFetch]: fetchImpl, timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
      });
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'type'],
        currentDate: new Date(now()),
      }));
    } catch (error) {
      if (['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC'].includes(error.code) || error instanceof TypeError) {
        fail(503, 'ADMIN_AUTH_UNAVAILABLE', 'Admin sign-in is temporarily unavailable.');
      }
      fail(401, 'ADMIN_INVALID_SESSION', 'Admin session is invalid or expired.');
    }
    const email = normalizeEmail(payload.email);
    if (payload.type !== 'app' || !UUID_PATTERN.test(payload.sub) || !validEmail(email)
        || !Number.isFinite(payload.iat) || payload.iat > now() / 1000 + 30 || payload.exp <= payload.iat
        || payload.email_verified === false || payload.common_name) {
      fail(401, 'ADMIN_INVALID_SESSION', 'Admin session is invalid or expired.');
    }
    if (!config.emails.includes(email)) fail(403, 'ADMIN_FORBIDDEN', 'This account is not a Gizmagick administrator.');
    // Owner identifiers do not expose email addresses and never come from a
    // manifest, browser preference, or the socket's self-declared Director role.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([config.issuer, payload.sub])));
    const id = `access:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    return { id, email, role: 'admin', expiresAt: payload.exp };
  };
}

export const requireAdmin = createAdminAuthenticator();
