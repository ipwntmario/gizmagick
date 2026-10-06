import { AdminAuthError, requireAdmin } from './admin-auth.js';

const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function adminPage({ principal, error, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gizmagick · Library admin</title><style nonce="${nonce}">
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#191723;color:#f3edf8}body{margin:0;padding:48px 24px}main{max-width:720px;margin:auto}header{border-bottom:1px solid #51465f;padding-bottom:24px}h1{font-size:2rem;margin:8px 0}p{line-height:1.6;color:#cfc5df}.eyebrow{color:#d8bd76;font-size:.85rem;letter-spacing:.12em;text-transform:uppercase}.card{margin-top:24px;padding:24px;border:1px solid #51465f;border-radius:16px;background:#242030}h2{font-size:1.2rem;margin:0 0 12px}.badge+h2{margin-top:20px}.badge{display:inline-block;padding:6px 12px;border-radius:20px;background:${principal ? '#264936' : '#514329'};color:#f3edf8}a{color:#e5cc8e}nav{display:flex;gap:24px;flex-wrap:wrap;margin-top:28px}code{overflow-wrap:anywhere}small{color:#b4a7c6}
    </style></head><body><main><header><div class="eyebrow">Gizmagick</div><h1>Library admin</h1><p>Secure access for managing the music library.</p></header>
    ${principal ? `<section class="card"><span class="badge">Administrator verified</span><h2>You’re signed in</h2><p>${escapeHTML(principal.email)}</p><small>Owner ID: <code>${escapeHTML(principal.id)}</code></small></section><section class="card"><h2>Next: uploads and publication</h2><p>Authentication is ready. Uploading, editing, and publishing tracks are not enabled yet. The public player and library are unchanged.</p></section>`
    : `<section class="card"><span class="badge">Admin access locked</span><h2>${error.code === 'ADMIN_NOT_CONFIGURED' ? 'Setup required' : 'Sign-in required'}</h2><p>${escapeHTML(error.message)}</p><p>Use the hostname protected by your Gizmagick Admin Cloudflare Access application. Gizmagick does not accept passwords or room roles as admin credentials.</p></section>`}
    <nav><a href="https://gizmagick.com">Open the player</a>${principal ? '<a href="/api/admin/session">View session status</a><a href="/cdn-cgi/access/logout">Sign out of Cloudflare Access</a>' : ''}</nav></main></body></html>`;
}

export function createAdminHandler(authorize = requireAdmin) {
  return async function handleAdminRequest(request, env) {
    const path = new URL(request.url).pathname;
    if (!(path === '/api/admin' || path.startsWith('/api/admin/') || path === '/admin' || path.startsWith('/admin/'))) return null;
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const headers = new Headers({
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
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
    // All future admin handlers must stay behind the same authorization and
    // origin/CSRF gate. There are intentionally no upload or write routes yet.
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.set('Allow', 'GET, HEAD');
      return reply({ error: 'Admin writes are not enabled', code: 'ADMIN_READ_ONLY' }, 405);
    }
    if (path === '/api/admin/session') return reply({ authenticated: true, principal, capabilities: { uploads: false, publishing: false } });
    if (['/admin', '/admin/'].includes(path)) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : adminPage({ principal, nonce }), { headers });
    }
    return reply({ error: 'Not found' }, 404);
  };
}

export const handleAdminRequest = createAdminHandler();
