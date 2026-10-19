import { adminClient } from './admin-client.js';
import { ORIGINAL_LIBRARY } from '../../shared/original-library.js';
export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function adminPage({ principal, error, nonce, uploads = false, originalImports = false, reviews = false, metadata = false, publishing = false, packages = false, batchReview = false, intents = false, copies = false, finalizing = false }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gizmagick · Library admin</title><style nonce="${nonce}">
    :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#191723;color:#f3edf8}*{box-sizing:border-box}body{margin:0;padding:40px 24px}main{max-width:1060px;margin:auto}header{border-bottom:1px solid #51465f;padding-bottom:20px}h1{font-size:2rem;margin:8px 0}p{line-height:1.6;color:#cfc5df}.eyebrow{color:#d8bd76;font-size:.85rem;letter-spacing:.12em;text-transform:uppercase}.card{margin-top:24px;padding:24px;border:1px solid #51465f;border-radius:16px;background:#242030}h2{font-size:1.2rem;margin:0 0 12px}.badge+h2{margin-top:20px}.badge{display:inline-block;padding:6px 12px;border-radius:20px;background:${principal ? '#264936' : '#514329'};color:#f3edf8}a{color:#e5cc8e}nav{display:flex;gap:24px;flex-wrap:wrap;margin-top:28px}code{overflow-wrap:anywhere}small{color:#b4a7c6}label{display:block;margin:16px 0 6px}input:not([type=checkbox]),select{display:block;width:100%;padding:10px;border:1px solid #776389;border-radius:8px;background:#191723;color:inherit;font:inherit}input[type=checkbox]{margin-right:8px}button{margin-top:12px;padding:10px 16px;background:#d8bd76;color:#21192b;border:0;border-radius:8px;font:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.secondary{background:#40364f;color:#f3edf8}ul{padding-left:20px}li{margin:12px 0;overflow-wrap:anywhere}li a{margin-left:12px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:24px}.notice{border-left:3px solid #d8bd76;padding-left:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;max-height:380px;overflow:auto}#status{white-space:pre-wrap;overflow-wrap:anywhere}#drop-zone{border:2px dashed #776389;border-radius:12px;padding:20px;margin-top:20px}[hidden]{display:none!important}@media(max-width:760px){.grid{display:block}body{padding:24px 14px}.card{padding:18px}}
    textarea{display:block;width:100%;min-height:320px;resize:vertical;padding:12px;border:1px solid #776389;border-radius:8px;background:#191723;color:inherit;font:13px/1.5 monospace}textarea:disabled{opacity:.6}
    </style></head><body><main><header><div class="eyebrow">Gizmagick</div><h1>Library admin</h1><p>Secure access for managing the music library.</p></header>
    ${principal ? `<section class="card"><span class="badge">Administrator verified</span><h2>You’re signed in</h2><p>${escapeHTML(principal.email)}</p><small>Owner ID: <code>${escapeHTML(principal.id)}</code></small></section>${uploads ? uploadPanel(reviews, metadata, publishing, packages, batchReview, intents, copies, finalizing, originalImports ? principal.id : null) : '<section class="card"><h2>Private uploads not enabled</h2><p>Authentication is ready. Private draft storage must be provisioned and explicitly enabled before uploading. Publishing remains disabled; the public library is unchanged.</p></section>'}`
    : `<section class="card"><span class="badge">Admin access locked</span><h2>${error.code === 'ADMIN_NOT_CONFIGURED' ? 'Setup required' : 'Sign-in required'}</h2><p>${escapeHTML(error.message)}</p><p>Use the hostname protected by your Gizmagick Admin Cloudflare Access application. Gizmagick does not accept passwords or room roles as admin credentials.</p></section>`}
    <nav><a href="https://gizmagick.com">Open the player</a>${principal ? '<a href="/api/admin/session">View session status</a><a href="/cdn-cgi/access/logout">Sign out of Cloudflare Access</a>' : ''}</nav></main>${principal && uploads ? `<script nonce="${nonce}">(${adminClient.toString()})();</script>` : ''}</body></html>`;
}

function uploadPanel(reviews, metadata, publishing, packages, batchReview, intents, copies, finalizing, originalOwner) {
  return `<section class="card notice"><h2>${publishing || copies || finalizing ? 'Private intake · deliberate publication' : 'Private drafts only'}</h2><p>Files start in private storage. Ogg identification, sizes, checksums, and graph rules are checked at intake. Decoding and audio duration have NOT been verified by the server. ${publishing || finalizing ? 'Only the separate, explicitly confirmed publishing steps below can copy files publicly and add a new track to the catalog.' : copies ? 'Each separately confirmed copy makes a file publicly downloadable by URL. Catalog publication is disabled; copying does not list the track or change the live player.' : 'Nothing here publishes or changes the live player.'}</p><p id="status" role="status" aria-live="polite">Loading private drafts…</p></section>
  <div class="grid"><section class="card"><h2>${originalOwner ? 'Create a draft or import an original' : 'Create a new-track draft'}</h2><form id="create-draft">
  <label for="source">Track data format / workflow</label><select id="source"><option value="legacy">New track from clipData.json + sectionData.json</option><option value="manifest">New track from merged manifest (schema v2)</option>${originalOwner ? '<option value="original">Import an original library track (preserve identity, private only)</option>' : ''}</select>
  <div id="legacy-fields"><label for="title">Track title</label><input id="title" maxlength="300" placeholder="Lena’s Home">
  <label for="clips-file">clipData.json</label><input id="clips-file" type="file" accept=".json,application/json">
  <label for="sections-file">sectionData.json</label><input id="sections-file" type="file" accept=".json,application/json">
  <label for="first-section">First section</label><select id="first-section"><option value="">Choose sectionData.json first</option></select>
  <label><input id="simple" type="checkbox">Simple track</label><label><input id="test-track" type="checkbox">Test track</label></div>
  <div id="manifest-fields" hidden><label for="manifest-file">Merged manifest.json</label><input id="manifest-file" type="file" accept=".json,application/json"><p>New-track mode assigns new track/version IDs. Original-library mode preserves the original track ID and assigns a fresh private version. Existing published tracks are never overwritten.</p></div>
  ${originalOwner ? `<div id="original-fields" class="notice" hidden><h3>Original-library private import</h3>
  <p>Choose the matching checked-in manifest.json from its original track folder. Only the fixed repository source snapshots are accepted. No cloud test copies are adopted. Audio must be uploaded separately; it has not been decoded or approved here.</p>
  <input id="original-owner" type="hidden" value="${escapeHTML(originalOwner)}">
  <label for="original-key">Original catalog key</label><select id="original-key"><option value="">Choose an original track</option>${ORIGINAL_LIBRARY.map(item => `<option value="${escapeHTML(item.legacyKey)}">${escapeHTML(item.legacyKey)}</option>`).join('')}</select>
  <label><input id="original-confirm" type="checkbox">I intend to reserve this original track ID and catalog key privately for my signed-in administrator account. This creates a private draft, not a publication. Archiving keeps this reservation; there is no cleanup/reimport button yet.</label>
  <p>Original imports cannot use the legacy publisher. First publication requires the separately enabled bounded original workflow, exact review and confirmations. No public destination/storage check or file copy occurs during intake. This does not change the live player.</p></div>` : ''}
  <button type="submit">Create private draft</button></form></section>
  <section class="card"><h2>Your recent drafts</h2><button id="refresh" class="secondary" type="button">Refresh drafts</button><ul id="draft-list"></ul></section></div>
  <section id="draft-detail" class="card" hidden><h2 id="draft-title"></h2><p id="draft-state"></p><a id="manifest-download">Download draft manifest</a>
  <ul id="asset-list"></ul><div id="drop-zone"><label for="audio-files">Choose audio files, or drop them here</label><input id="audio-files" type="file" accept=".ogg,audio/ogg,application/ogg" multiple><p id="file-selection">No files selected.</p><button id="upload" type="button" disabled>Upload selected audio privately</button></div>
  <details><summary>Graph warnings</summary><pre id="warnings"></pre></details><details><summary>Merged draft data</summary><pre id="manifest-view"></pre></details>
  <details id="storage-inspection-panel"><summary>Inspect private storage in small batches</summary>
  <p>Read-only checks of up to 16 files per click. Checks sizes and stored checksums, not audio decoding. Different batches are checked at different times; finishing a pass is NOT an approval, review package or publishing permission.</p>
  <p id="inspection-state" role="status" aria-live="polite">Open an active, fully uploaded draft to inspect its private files.</p>
  <label for="inspection-progress">Files checked during this pass</label><progress id="inspection-progress" value="0" max="1"></progress>
  <button id="inspection-next" class="secondary" type="button" disabled>Check next private batch (read only)</button>
  <button id="inspection-reset" class="secondary" type="button" disabled>Restart inspection pass</button>
  <pre id="inspection-results"></pre></details>
  ${metadata ? `<details><summary>Edit private metadata (JSON)</summary><p id="metadata-state"></p>
  <p>Edit titles, sections, modes, transitions and clip timings. Keep track/version IDs and the entire assets object unchanged. Save before downloading a fresh review package. Attested and archived drafts are locked; this does not edit published tracks.</p>
  <label for="metadata-editor">Draft manifest JSON</label><textarea id="metadata-editor" spellcheck="false" disabled></textarea>
  <button id="save-metadata" type="button" disabled>Save private metadata</button>
  <button id="reset-metadata" class="secondary" type="button" disabled>Discard unsaved edits</button></details>` : ''}
  ${reviews ? `<section aria-labelledby="review-heading"><h2 id="review-heading">Local administrator review</h2>
  <p id="review-state">No administrator attestation recorded.</p>
  <p>After all files are uploaded, download a review package. Save the private audio files under an <code>audio/</code> folder with their original names. Run the repository’s local validator against that package, then choose its report below.</p>
  <button id="review-package" class="secondary" type="button" disabled>Download review package${packages ? ' (single request)' : ''}</button>
  ${packages ? `<section id="package-panel" class="notice"><h3>Prepare a review package in batches</h3>
  <p>Private preparation only. Progress is saved on the server for up to 24 hours, with at most 16 file checks per click. These checks happen at separate times and do not decode audio or approve a track. The existing local validator and full approval recheck are still required.</p>
  <p id="package-state" role="status" aria-live="polite">Refresh preparation status before continuing.</p>
  <label for="package-progress">Files recorded in this preparation</label><progress id="package-progress" value="0" max="1"></progress>
  <button id="package-refresh" class="secondary" type="button" disabled>Refresh preparation status (read only)</button>
  <button id="package-start" class="secondary" type="button" disabled>Start or resume package preparation</button>
  <button id="package-next" class="secondary" type="button" disabled>Check next package batch</button>
  <button id="package-restart" class="secondary" type="button" disabled>Restart package checks</button>
  <p>Restarting discards this preparation’s checks and its completed package, invalidating reports for that package. It does not delete audio. Packages and reports remain private and do not unlock publishing for large tracks.</p></section>` : ''}
  <pre>node scripts/gizmagick-audio-probe.mjs --review-package "C:/path/draft-review-package.json" --track-root "C:/path/track" | Set-Content -Encoding utf8 "C:/path/review-report.json"</pre>
  <p>Run from the repository’s frontend directory. Packages expire after 24 hours. Download a new package if it expires.</p>
  <label for="review-report">Local validator report</label><input id="review-report" type="file" accept=".json,application/json">
  <pre id="review-summary">Choose a successful report to inspect its measurements.</pre>
  <label><input id="review-confirm" type="checkbox">I personally ran this exact review package and audio through Gizmagick’s pinned local validator and reviewed the successful measurements and graph warnings. This is my administrator attestation, not proof of server-side decoding.</label>
  <button id="attest-review" type="button" disabled>Record administrator attestation (keep private${batchReview ? ', single-request recheck' : ''})</button>
  ${batchReview ? `<section id="verification-panel" class="notice"><h3>Recheck and attest in batches</h3>
  <p>Choose your personally validated report and confirm the personal-run statement above. Start checks, then recheck up to 16 private files per click. Preparing or checking batches alone records no approval.</p>
  <p id="verification-state" role="status" aria-live="polite">Verification status unknown. Refresh or explicitly start checks.</p>
  <label for="verification-progress">Files rechecked against the exact report package</label><progress id="verification-progress" value="0" max="1"></progress>
  <button id="verification-refresh" class="secondary" type="button" disabled>Refresh recheck status (read only)</button>
  <button id="verification-start" class="secondary" type="button" disabled>Start or resume approval rechecks</button>
  <button id="verification-restart" class="secondary" type="button" disabled>Restart unapproved rechecks</button>
  <button id="verification-next" class="secondary" type="button" disabled>Recheck next private batch</button>
  <label><input id="verification-confirm" type="checkbox" disabled>I personally validated this exact report and accept that storage checks occurred in separate batches, not as one atomic snapshot. Earlier objects are not rechecked at final confirmation. I intend to record this private administrator attestation; it does not permit publishing.</label>
  <button id="verification-attest" type="button" disabled>Record batched administrator attestation (keep private)</button>
  <p>Every check must be at most five minutes old at final confirmation. Attempts expire after 15 minutes or when their package expires, whichever is sooner. Earlier results cannot prove that privileged external storage changes did not occur after a batch. Normal Gizmagick uploads never overwrite private files. This distinct review type is recorded in the audit and can be published only through the separately enabled bounded workflow, not the legacy publisher.</p></section>` : ''}
  <p>Reports alone cannot approve a draft. This records your verified administrator identity and the exact report and file snapshot. It does not publish files or mark them server-decoded.</p></section>` : ''}
  ${publishing ? `<section class="card notice" aria-labelledby="publication-heading" id="publication-panel"><h2 id="publication-heading">Publish a new track</h2>
  <p>New tracks only, up to 16 audio files. Administrator attestation is required; it is NOT server-side decoding. Existing tracks and public files will never be overwritten.</p>
  <p>Each copy makes a file publicly downloadable by URL, even before catalog publication. Interrupting this workflow or archiving a draft does not remove public files or unpublish a track. There is no undo or cleanup button here.</p>
  <pre id="publication-identity"></pre><p id="publication-state" role="status" aria-live="polite">Open a draft to read its publication status.</p>
  <label for="publication-progress">Recorded public copies (audio first, manifest last)</label><progress id="publication-progress" value="0" max="1"></progress>
  <button id="publication-refresh" class="secondary" type="button" disabled>Refresh publication status (read only)</button>
  <button id="publication-check" class="secondary" type="button" disabled>Check readiness (read only)</button>
  <pre id="publication-preview"></pre>
  <label><input id="publication-confirm" type="checkbox" disabled>I intend to publish this exact track/version. I understand that copied audio and its manifest become public by URL before catalog publication, and archiving cannot undo this.</label>
  <button id="publication-action" type="button" disabled>Create publication intent (no copies yet)</button>
  <p>Every action needs a fresh confirmation. One file is copied per click; the final, separate action verifies all copies and publishes to the catalog. Reloading only reads progress—it never resumes writes automatically. If a request fails, refresh status before deciding whether to continue.</p></section>` : ''}
  ${intents ? `<section id="intent-panel" class="notice"><h2>Prepare a bounded publication intent</h2>
  <p>Supports up to 256 reviewed audio files, including separate-batch administrator reviews. Each readiness click checks at most 16 private sources and 16 public destinations; preparation and reservation copy nothing. ${copies ? 'After reservation, a separate confirmed click can copy one file publicly.' : 'Public copying is disabled.'} ${finalizing ? 'Use the separate final-verification panel after all copies are recorded.' : 'Final catalog publication is still locked.'}</p>
  <pre id="intent-identity"></pre><p id="intent-state" role="status" aria-live="polite">Refresh intent status before starting.</p>
  <label for="intent-progress">Readiness checks, or recorded public copies after reservation (audio, then manifest)</label><progress id="intent-progress" value="0" max="1"></progress>
  <button id="intent-refresh" class="secondary" type="button" disabled>Refresh intent status (read only)</button>
  <button id="intent-prepare" class="secondary" type="button" disabled>Prepare or resume readiness checks</button>
  <button id="intent-restart" class="secondary" type="button" disabled>Restart readiness checks</button>
  <button id="intent-next" class="secondary" type="button" disabled>Check next readiness batch (no public write)</button>
  <label><input id="intent-confirm" type="checkbox" disabled>I intend to reserve this exact new track/version for future publication. I accept that readiness checks happened in separate batches, not as one atomic snapshot. An intent is immutable and archiving cannot remove it. Copied files will be public by URL before catalog publication; catalog publication needs independent fresh checks and separate confirmation.</label>
  <button id="intent-reserve" type="button" disabled>Reserve immutable intent (no public copies)</button>
  ${copies ? `<label><input id="intent-copy-confirm" type="checkbox" disabled>I authorize copying the next object of this exact fixed plan. Its bytes become publicly downloadable immediately, even before catalog publication. Archiving or disabling writes will not remove them.</label>
  <button id="intent-copy" type="button" disabled>Copy one object publicly</button>
  <p>Each copy needs a fresh confirmation. A repeated request for the same object never copies the following file. After any error, refresh status before deciding whether to retry; files may already be public even without a recorded receipt. Nothing resumes automatically.</p>` : ''}
  <p>Checks must be at most five minutes old; preparations expire after 15 minutes. Earlier objects/destinations are not rechecked at reservation. This is not permission to publish from old receipts; future copying must independently verify exact sources/destinations and final catalog publication needs independent fresh verification. Existing public files remain public even when writes are disabled.</p></section>` : ''}
  ${finalizing ? `<section id="final-panel" class="notice"><h2>Final verification and catalog publication</h2>
  <p>In plain English: check the private originals and public copies again in small groups, then separately confirm adding this exact track/version to the catalog. No files are copied or deleted by this panel.</p>
  <pre id="final-identity"></pre><p id="final-state" role="status" aria-live="polite">Refresh final status before starting.</p>
  <label for="final-progress">Objects freshly checked (audio, then manifest)</label><progress id="final-progress" value="0" max="1"></progress>
  <button id="final-refresh" class="secondary" type="button" disabled>Refresh final status (read only)</button>
  <button id="final-start" class="secondary" type="button" disabled>Start or resume final verification</button>
  <button id="final-restart" class="secondary" type="button" disabled>Restart final verification</button>
  <button id="final-next" class="secondary" type="button" disabled>Check next final batch (no catalog change)</button>
  <label><input id="final-confirm" type="checkbox" disabled>I authorize adding this exact new track/version to the public catalog. I accept that files were checked in separate recent batches, not an atomic storage snapshot; earlier files are not rechecked at this final confirmation. This is my administrator attestation, NOT server-side decoding. Archiving cannot unpublish it.</label>
  <button id="final-commit" type="button" disabled>Confirm publication to catalog</button>
  <p>Checks must be at most five minutes old, and the pass expires after 15 minutes. Privileged external storage changes after an earlier check cannot be ruled out. A stale pass requires an explicit restart. Reloading or errors never resume writes automatically; refresh status after an interrupted commit before deciding what to do. The catalog entry, version, public pointer and commit audit change together or not at all.</p></section>` : ''}
  <button id="archive" class="secondary" type="button" disabled>Archive draft (keep private files)</button></section>`;
}
