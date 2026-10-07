import { adminClient } from './admin-client.js';
export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function adminPage({ principal, error, nonce, uploads = false, reviews = false }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gizmagick · Library admin</title><style nonce="${nonce}">
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#191723;color:#f3edf8}*{box-sizing:border-box}body{margin:0;padding:40px 24px}main{max-width:1060px;margin:auto}header{border-bottom:1px solid #51465f;padding-bottom:20px}h1{font-size:2rem;margin:8px 0}p{line-height:1.6;color:#cfc5df}.eyebrow{color:#d8bd76;font-size:.85rem;letter-spacing:.12em;text-transform:uppercase}.card{margin-top:24px;padding:24px;border:1px solid #51465f;border-radius:16px;background:#242030}h2{font-size:1.2rem;margin:0 0 12px}.badge+h2{margin-top:20px}.badge{display:inline-block;padding:6px 12px;border-radius:20px;background:${principal ? '#264936' : '#514329'};color:#f3edf8}a{color:#e5cc8e}nav{display:flex;gap:24px;flex-wrap:wrap;margin-top:28px}code{overflow-wrap:anywhere}small{color:#b4a7c6}label{display:block;margin:16px 0 6px}input:not([type=checkbox]),select{display:block;width:100%;padding:10px;border:1px solid #776389;border-radius:8px;background:#191723;color:inherit;font:inherit}input[type=checkbox]{margin-right:8px}button{margin-top:12px;padding:10px 16px;background:#d8bd76;color:#21192b;border:0;border-radius:8px;font:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.secondary{background:#40364f;color:#f3edf8}ul{padding-left:20px}li{margin:12px 0;overflow-wrap:anywhere}li a{margin-left:12px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:24px}.notice{border-left:3px solid #d8bd76;padding-left:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;max-height:380px;overflow:auto}#status{white-space:pre-wrap;overflow-wrap:anywhere}#drop-zone{border:2px dashed #776389;border-radius:12px;padding:20px;margin-top:20px}[hidden]{display:none!important}@media(max-width:760px){.grid{display:block}body{padding:24px 14px}.card{padding:18px}}
    </style></head><body><main><header><div class="eyebrow">Gizmagick</div><h1>Library admin</h1><p>Secure access for managing the music library.</p></header>
    ${principal ? `<section class="card"><span class="badge">Administrator verified</span><h2>You’re signed in</h2><p>${escapeHTML(principal.email)}</p><small>Owner ID: <code>${escapeHTML(principal.id)}</code></small></section>${uploads ? uploadPanel(reviews) : '<section class="card"><h2>Private uploads not enabled</h2><p>Authentication is ready. Private draft storage must be provisioned and explicitly enabled before uploading. Publishing remains disabled; the public library is unchanged.</p></section>'}`
    : `<section class="card"><span class="badge">Admin access locked</span><h2>${error.code === 'ADMIN_NOT_CONFIGURED' ? 'Setup required' : 'Sign-in required'}</h2><p>${escapeHTML(error.message)}</p><p>Use the hostname protected by your Gizmagick Admin Cloudflare Access application. Gizmagick does not accept passwords or room roles as admin credentials.</p></section>`}
    <nav><a href="https://gizmagick.com">Open the player</a>${principal ? '<a href="/api/admin/session">View session status</a><a href="/cdn-cgi/access/logout">Sign out of Cloudflare Access</a>' : ''}</nav></main>${principal && uploads ? `<script nonce="${nonce}">(${adminClient.toString()})();</script>` : ''}</body></html>`;
}

function uploadPanel(reviews) {
  return `<section class="card notice"><h2>Private drafts only</h2><p>Files stay in private storage. Ogg identification, sizes, checksums, and graph rules are checked at intake. Decoding and audio duration have NOT been verified. Nothing here publishes or changes the live player.</p><p id="status" role="status" aria-live="polite">Loading private drafts…</p></section>
  <div class="grid"><section class="card"><h2>Create a new-track draft</h2><form id="create-draft">
  <label for="source">Track data format</label><select id="source"><option value="legacy">Existing clipData.json + sectionData.json</option><option value="manifest">Merged track manifest (schema v2)</option></select>
  <div id="legacy-fields"><label for="title">Track title</label><input id="title" maxlength="300" placeholder="Lena’s Home">
  <label for="clips-file">clipData.json</label><input id="clips-file" type="file" accept=".json,application/json">
  <label for="sections-file">sectionData.json</label><input id="sections-file" type="file" accept=".json,application/json">
  <label for="first-section">First section</label><select id="first-section"><option value="">Choose sectionData.json first</option></select>
  <label><input id="simple" type="checkbox">Simple track</label><label><input id="test-track" type="checkbox">Test track</label></div>
  <div id="manifest-fields" hidden><label for="manifest-file">Merged manifest.json</label><input id="manifest-file" type="file" accept=".json,application/json"><p>Imports get new private track/version IDs; existing published tracks are never overwritten.</p></div>
  <button type="submit">Create private draft</button></form></section>
  <section class="card"><h2>Your recent drafts</h2><button id="refresh" class="secondary" type="button">Refresh drafts</button><ul id="draft-list"></ul></section></div>
  <section id="draft-detail" class="card" hidden><h2 id="draft-title"></h2><p id="draft-state"></p><a id="manifest-download">Download draft manifest</a>
  <ul id="asset-list"></ul><div id="drop-zone"><label for="audio-files">Choose audio files, or drop them here</label><input id="audio-files" type="file" accept=".ogg,audio/ogg,application/ogg" multiple><p id="file-selection">No files selected.</p><button id="upload" type="button" disabled>Upload selected audio privately</button></div>
  <details><summary>Graph warnings</summary><pre id="warnings"></pre></details><details><summary>Merged draft data</summary><pre id="manifest-view"></pre></details>
  ${reviews ? `<section aria-labelledby="review-heading"><h2 id="review-heading">Local administrator review</h2>
  <p id="review-state">No administrator attestation recorded.</p>
  <p>After all files are uploaded, download a review package. Save the private audio files under an <code>audio/</code> folder with their original names. Run the repository’s local validator against that package, then choose its report below.</p>
  <button id="review-package" class="secondary" type="button" disabled>Download review package</button>
  <pre>node scripts/gizmagick-audio-probe.mjs --review-package "C:/path/draft-review-package.json" --track-root "C:/path/track" | Set-Content -Encoding utf8 "C:/path/review-report.json"</pre>
  <p>Run from the repository’s frontend directory. Packages expire after 24 hours. Download a new package if it expires.</p>
  <label for="review-report">Local validator report</label><input id="review-report" type="file" accept=".json,application/json">
  <pre id="review-summary">Choose a successful report to inspect its measurements.</pre>
  <label><input id="review-confirm" type="checkbox">I personally ran this exact review package and audio through Gizmagick’s pinned local validator and reviewed the successful measurements and graph warnings. This is my administrator attestation, not proof of server-side decoding.</label>
  <button id="attest-review" type="button" disabled>Record administrator attestation (keep private)</button>
  <p>Reports alone cannot approve a draft. This records your verified administrator identity and the exact report and file snapshot. It does not publish files or mark them server-decoded.</p></section>` : ''}
  <button id="archive" class="secondary" type="button" disabled>Archive draft (keep private files)</button></section>`;
}
