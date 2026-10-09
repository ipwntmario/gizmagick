import { AdminAuthError, requireAdmin } from './admin-auth.js';
import { adminPage } from './admin-page.js';
import { draftsEnabled, handleDraftRequest, metadataEnabled } from './admin-drafts.js';
import { reviewsEnabled } from './admin-reviews.js';


export function createAdminHandler(authorize = requireAdmin) {
  return async function handleAdminRequest(request, env) {
    const path = new URL(request.url).pathname;
    if (!(path === '/api/admin' || path.startsWith('/api/admin/') || path === '/admin' || path.startsWith('/admin/'))) return null;
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const headers = new Headers({
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'Vary': 'Origin, Cf-Access-Jwt-Assertion',
    });
    const reply = (body, status = 200) => {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
    };
    let principal;
    try { principal = await authorize(request, env); }
    catch (caught) {
      const error = caught instanceof AdminAuthError ? caught : new AdminAuthError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Admin sign-in is temporarily unavailable.');
      if (['/admin', '/admin/'].includes(path) && ['GET', 'HEAD'].includes(request.method)) {
        headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(request.method === 'HEAD' ? null : adminPage({ error, nonce }), { status: error.status, headers });
      }
      return reply({ error: error.message, code: error.code }, error.status);
    }
    // Every private draft operation stays behind this same JWT and origin gate.
    const draftResponse = await handleDraftRequest(request, env, principal, reply, headers);
    if (draftResponse) return draftResponse;
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.set('Allow', 'GET, HEAD');
      return reply({ error: 'Admin writes are not enabled', code: 'ADMIN_READ_ONLY' }, 405);
    }
    if (path === '/api/admin/session') return reply({ authenticated: true, principal, capabilities: { uploads: draftsEnabled(env), reviews: draftsEnabled(env) && reviewsEnabled(env), metadata: metadataEnabled(env), publishing: false } });
    if (['/admin', '/admin/'].includes(path)) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : adminPage({ principal, nonce, uploads: draftsEnabled(env), reviews: reviewsEnabled(env), metadata: metadataEnabled(env) }), { headers });
    }
    return reply({ error: 'Not found' }, 404);
  };
}

export const handleAdminRequest = createAdminHandler();
