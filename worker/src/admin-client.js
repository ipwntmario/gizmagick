// Serialized into the nonce-protected admin page. No JWTs or emails in browser
// storage, and no client-side role/ownership decisions.
export function adminClient() {
  const byId = id => document.getElementById(id);
  let current = null, selectedFiles = [], creationBody = null, busy = false, reviewReport = null;
  const publishing = Boolean(byId('publication-panel'));
  // undefined means unknown: no write is allowed until a successful status GET.
  let publication, publicationReady = false, publicationRequest = null;
  const inspecting = Boolean(byId('storage-inspection-panel'));
  const batchPackaging = Boolean(byId('package-panel'));
  const batchReview = Boolean(byId('verification-panel'));
  let verification, reviewReportSha256 = null;
  const digestJSON = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
  const reviewLabel = review => `Administrator-attested by ${review.approvedBy} at ${review.approvedAt}. NOT server-decoded. Report SHA-256: ${review.reportSha256}`
    + (review.storageCheckScope === 'bounded-batches' ? `\nPrivate storage checked in separate batches from ${new Date(review.storageCheckedFrom * 1000).toISOString()} to ${new Date(review.storageCheckedUntil * 1000).toISOString()}; not an atomic snapshot. This review type cannot be published yet.` : '');
  function clearVerificationConfirmation() { if (batchReview) byId('verification-confirm').checked = false; }
  function renderVerification() {
    if (!batchReview) return;
    byId('verification-progress').max = verification?.totalAssets || 1;
    byId('verification-progress').value = verification?.checkedAssets || 0;
    byId('verification-state').textContent = verification === undefined ? 'Recheck status unknown. Refresh or explicitly start a pass; no new approval may be inferred.'
      : verification === null ? 'No approval recheck pass. Choose your personally validated report and confirm provenance to start.'
      : `${verification.checkedAssets}/${verification.totalAssets} files rechecked. Report SHA-256: ${verification.reportSha256}\nPackage: ${verification.jobId}\nVerification: ${verification.id}\n${verification.state === 'attested' ? 'Administrator attestation recorded with point-in-time batch scope. NOT server-decoded; publishing unsupported for this review type.' : `Expires: ${new Date(verification.expiresAt * 1000).toISOString()}. Every check must be at most five minutes old at final confirmation. Checking alone grants no approval.`}`;
  }
  function acceptVerification(result) {
    const value = result.verification, total = Object.keys(current.manifest.assets).length;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, sha = /^[a-f0-9]{64}$/;
    if (result.audioProbed !== false || result.serverDecoded !== false || result.publishing !== false
        || result.publicationAuthorized !== false || result.pointInTimeBatches !== true
        || (value !== null && (!value || !uuid.test(value.id) || !uuid.test(value.jobId)
          || value.draftId !== current.id || value.trackId !== current.manifest.track.id || value.versionId !== current.manifest.versionId
          || value.manifestSha256 !== current.manifestSha256 || !sha.test(value.reportSha256) || !sha.test(value.snapshotSha256)
          || value.totalAssets !== total || total < 1 || total > 256 || !Number.isInteger(value.checkedAssets)
          || value.checkedAssets < 0 || value.checkedAssets > total || (value.checkedAssets !== total && value.checkedAssets % 16)
          || !['pending', 'attested'].includes(value.state) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt > 8640000000000
          || (value.state === 'pending' && value.expiresAt <= Date.now() / 1000)
          || (value.checkedAssets === 0 ? value.firstCheckedAt !== null || value.lastCheckedAt !== null
            : !Number.isSafeInteger(value.firstCheckedAt) || !Number.isSafeInteger(value.lastCheckedAt)
              || value.firstCheckedAt > value.lastCheckedAt || value.firstCheckedAt < 0 || value.lastCheckedAt > 8640000000000)
          || (value.state === 'attested' && (value.checkedAssets !== total || result.review?.storageCheckScope !== 'bounded-batches'
            || result.review.storageVerificationId !== value.id || result.review.reportSha256 !== value.reportSha256
            || result.review.storageCheckedFrom !== value.firstCheckedAt || result.review.storageCheckedUntil !== value.lastCheckedAt
            || result.review.serverDecoded !== false)))) || (value === null && result.review !== null)
        || (value?.state === 'pending' && result.review !== null)) throw new Error('Recheck response does not match the loaded draft and verification scope. Refresh before continuing.');
    verification = value; renderVerification();
  }
  let packagePreparation;
  const packageEligible = () => Boolean(current?.status === 'draft' && !current.review && !current.missingAssets.length && !metadataDirty());
  function renderPreparation() {
    if (!batchPackaging) return;
    byId('package-progress').max = packagePreparation?.totalAssets || 1;
    byId('package-progress').value = packagePreparation?.checkedAssets || 0;
    byId('package-next').textContent = packagePreparation?.checkedAssets === packagePreparation?.totalAssets && packagePreparation
      ? packagePreparation.ready ? 'Download completed package again' : 'Finish and download review package' : 'Check next package batch';
    byId('package-state').textContent = packagePreparation === undefined ? 'Preparation status unknown. Refresh, or deliberately start/resume preparation. No approval was recorded by preparation.'
      : packagePreparation === null ? 'No package preparation. Start one explicitly; no audio is decoded or approved.'
      : `${packagePreparation.checkedAssets}/${packagePreparation.totalAssets} file checks recorded. Package ${packagePreparation.jobId}\nExpires: ${new Date(packagePreparation.expiresAt * 1000).toISOString()}\n${packagePreparation.ready ? 'Package prepared, NOT approved. Run the local validator and confirm provenance separately.' : 'Paused until your next click; these checks happen at separate times, not as one atomic storage snapshot.'}`;
  }
  function acceptPreparation(result) {
    const prep = result.preparation, total = Object.keys(current.manifest.assets).length;
    if (result.audioProbed !== false || result.publishing !== false || result.publicationAuthorized !== false
        || (prep !== null && (!prep || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(prep.jobId)
          || prep.draftId !== current.id || prep.trackId !== current.manifest.track.id || prep.versionId !== current.manifest.versionId
          || prep.manifestSha256 !== current.manifestSha256 || prep.totalAssets !== total || total < 1 || total > 256
          || !Number.isInteger(prep.checkedAssets) || prep.checkedAssets < 0 || prep.checkedAssets > total
          || (prep.checkedAssets !== total && prep.checkedAssets % 16 !== 0)
          || typeof prep.ready !== 'boolean' || (prep.ready && prep.checkedAssets !== total)
          || !Number.isSafeInteger(prep.expiresAt) || prep.expiresAt <= Date.now() / 1000 || prep.expiresAt > 8640000000000))) {
      throw new Error('Package preparation response does not match the loaded draft. Refresh before continuing.');
    }
    packagePreparation = prep; renderPreparation();
  }
  let inspectionOffset = 0, inspectionPin = null, inspectionStopped = false;
  function resetInspection(message = 'No files checked in this pass. This is not audio validation or approval.') {
    inspectionOffset = 0; inspectionPin = null; inspectionStopped = false;
    if (!inspecting) return;
    byId('inspection-progress').value = 0;
    byId('inspection-progress').max = current ? Object.keys(current.manifest.assets).length : 1;
    byId('inspection-results').textContent = '';
    byId('inspection-state').textContent = message;
  }
  const status = message => { byId('status').textContent = message; };
  const metadataDirty = () => Boolean(current && byId('metadata-editor') && byId('metadata-editor').value !== JSON.stringify(current.manifest, null, 2));
  const publicationEligible = () => Boolean(current?.status === 'draft' && current.review
    && current.review.storageCheckScope !== 'bounded-batches'
    && !current.missingAssets.length && Object.keys(current.manifest.assets).length <= 16 && !metadataDirty());
  const publicationWritable = () => publicationEligible() && publication !== undefined
    && (publication === null ? publicationReady : publication.state === 'pending');
  function clearPublicationConfirmation() {
    if (publishing) byId('publication-confirm').checked = false;
  }
  function renderPublication() {
    if (!publishing) return;
    const published = publication?.state === 'published';
    byId('publication-identity').textContent = current
      ? `Track: ${current.title}\nTrack ID: ${current.manifest.track.id}\nVersion: ${current.manifest.versionId}` : '';
    byId('publication-progress').max = publication?.totalObjects || 1;
    byId('publication-progress').value = publication?.copiedObjects || 0;
    byId('publication-action').textContent = published ? 'Already published'
      : publication?.nextAction === 'verify-and-commit' ? 'Verify copies and publish to catalog'
      : publication ? 'Copy next file publicly' : 'Create publication intent (no copies yet)';
    byId('publication-state').textContent = !current ? 'Open a draft to read its publication status.'
      : publication === undefined ? 'Status unknown. Refresh publication status before any write.'
      : published ? `Published to the catalog at ${publication.publishedAt}. ${publication.copiedObjects}/${publication.totalObjects} public copies verified. Archiving does not unpublish this track.`
      : publication ? `Publication intent ${publication.id}\n${publication.copiedObjects}/${publication.totalObjects} public copies recorded. Files may already be public even if a failed copy has no receipt. ${current.status !== 'draft' ? 'Archived: continuation is locked.' : publication.nextAction === 'verify-and-commit' ? 'All copies recorded. Final verification and catalog publication require a separate confirmation.' : 'Paused until you explicitly confirm and copy the next file.'}`
      : current.review?.storageCheckScope === 'bounded-batches' ? 'This review used separate storage batches. The current publisher does not support this review type; public writes are locked.'
      : !publicationEligible() ? 'No publication intent. An active, saved, administrator-attested draft with all audio uploaded and at most 16 audio files is required.'
      : publicationReady ? 'Readiness checks passed at this moment only. Creating an intent copies nothing; later actions recheck the exact review and files.'
      : 'No publication intent. Check readiness before creating one. No public files have been copied by this workflow.';
    if (current) {
      byId('draft-state').textContent = `${current.status} · ${current.missingAssets.length} missing audio file(s) · NOT server-decoded · ${published ? 'Published' : publication === undefined ? 'Publication status unknown' : publication ? 'Publication pending; files may be public' : 'NOT published'}`;
      if (byId('review-state') && current.review) byId('review-state').textContent = reviewLabel(current.review);
    }
  }
  function clearReview() {
    reviewReport = null; reviewReportSha256 = null; clearVerificationConfirmation();
    if (byId('review-report')) {
      byId('review-report').value = '';
      byId('review-confirm').checked = false;
      byId('review-summary').textContent = 'Choose a successful report to inspect its measurements.';
    }
  }
  const setBusy = value => {
    busy = value;
    for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = value;
    byId('upload').disabled = value || !current || current.status !== 'draft' || Boolean(current.review) || !selectedFiles.length || metadataDirty();
    byId('archive').disabled = value || !current || current.status !== 'draft';
    if (batchReview) {
      const eligible = packageEligible(), matches = Boolean(reviewReport && verification && reviewReportSha256 === verification.reportSha256);
      const pending = eligible && verification?.state === 'pending';
      byId('verification-refresh').disabled = value || !current || metadataDirty();
      byId('verification-start').disabled = value || !eligible || !reviewReport || !byId('review-confirm').checked;
      byId('verification-restart').disabled = value || !pending || !matches || !byId('review-confirm').checked;
      byId('verification-next').disabled = value || !pending || verification.checkedAssets >= verification.totalAssets
        || Boolean(reviewReport && !matches);
      const final = pending && matches && verification.checkedAssets === verification.totalAssets
        && verification.expiresAt > Date.now() / 1000 && verification.firstCheckedAt >= Date.now() / 1000 - 300 && byId('review-confirm').checked;
      byId('verification-confirm').disabled = value || !final;
      byId('verification-attest').disabled = value || !final || !byId('verification-confirm').checked;
      renderVerification();
    }
    if (batchPackaging) {
      byId('package-refresh').disabled = value || !current || current.status !== 'draft' || Boolean(current.review) || metadataDirty();
      byId('package-start').disabled = value || !packageEligible();
      byId('package-next').disabled = value || !packageEligible() || !packagePreparation;
      byId('package-restart').disabled = value || !packageEligible() || !packagePreparation;
      renderPreparation();
    }
    if (inspecting) {
      byId('inspection-next').disabled = value || !current || current.status !== 'draft'
        || current.missingAssets.length > 0 || metadataDirty() || inspectionStopped;
      byId('inspection-reset').disabled = value || !current;
    }
    if (byId('review-package')) {
      const cannotReview = value || !current || current.status !== 'draft' || current.missingAssets.length > 0 || Boolean(current.review) || metadataDirty();
      byId('review-package').disabled = cannotReview;
      byId('review-report').disabled = cannotReview;
      byId('review-confirm').disabled = cannotReview || !reviewReport;
      byId('attest-review').disabled = cannotReview || !reviewReport || !byId('review-confirm').checked
        || (batchReview && (verification?.state === 'pending' || Object.keys(current?.manifest.assets || {}).length > 16));
    }
    if (byId('metadata-editor')) {
      byId('metadata-editor').disabled = value || !current?.metadataEditable;
      byId('save-metadata').disabled = value || !current?.metadataEditable || !metadataDirty();
      byId('reset-metadata').disabled = value || !current || !metadataDirty();
    }
    if (publishing) {
      byId('publication-refresh').disabled = value || !current || metadataDirty();
      byId('publication-check').disabled = value || !publicationEligible() || publication !== null;
      byId('publication-confirm').disabled = value || !publicationWritable();
      byId('publication-action').disabled = value || !publicationWritable() || !byId('publication-confirm').checked;
      renderPublication();
    }
  };
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: {
      ...(method !== 'GET' ? { 'X-Gizmagick-Admin-Request': '1' } : {}),
      ...(body ? { 'Content-Type': body instanceof File ? 'application/octet-stream' : 'application/json' } : {}),
    }, body });
    if (response.redirected || !response.headers.get('Content-Type')?.includes('application/json')) throw new Error('Your session may have expired. Reload and sign in again.');
    const result = await response.json();
    if (!response.ok) throw new Error(`${result.error || 'Request failed'}${result.details ? '\n' + result.details.map(item => item.path + ': ' + item.message).join('\n') : ''}`);
    return result;
  }
  const pathFor = id => `/api/admin/drafts/${encodeURIComponent(id)}`;
  function acceptPublication(result) {
    const saved = result.publication;
    if (saved !== null && (!saved || typeof saved.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(saved.id)
        || saved.draftId !== current.id || saved.trackId !== current.manifest.track.id
        || saved.versionId !== current.manifest.versionId || !['pending', 'published'].includes(saved.state)
        || !Number.isInteger(saved.copiedObjects) || !Number.isInteger(saved.totalObjects)
        || saved.copiedObjects < 0 || saved.totalObjects !== Object.keys(current.manifest.assets).length + 1
        || saved.copiedObjects > saved.totalObjects
        || (saved.state === 'published' && (saved.copiedObjects !== saved.totalObjects || typeof saved.publishedAt !== 'string'))
        || saved.nextAction !== (saved.state === 'published' ? null : saved.copiedObjects < saved.totalObjects ? 'copy-one-object' : 'verify-and-commit'))) {
      throw new Error('Publication status could not be verified. Refresh before continuing.');
    }
    publication = saved;
    renderPublication();
  }
  async function loadPublication() {
    if (!publishing || !current) return;
    publication = undefined; publicationReady = false; clearPublicationConfirmation();
    byId('publication-preview').textContent = '';
    renderPublication();
    acceptPublication(await api(`${pathFor(current.id)}/publication`));
  }
  function showDraft(draft) {
    const metadataChanged = current?.id !== draft.id || current?.manifestSha256 !== draft.manifestSha256;
    if (current?.id !== draft.id) {
      selectedFiles = [];
      byId('audio-files').value = '';
      byId('file-selection').textContent = 'No files selected.';
    }
    if (metadataChanged) clearReview();
    if (publishing) {
      if (metadataChanged) publicationRequest = null;
      publication = undefined; publicationReady = false; clearPublicationConfirmation();
      byId('publication-preview').textContent = '';
    }
    if (byId('metadata-editor')) {
      if (metadataChanged) byId('metadata-editor').value = JSON.stringify(draft.manifest, null, 2);
      byId('metadata-state').textContent = draft.metadataEditable
        ? 'Unreviewed private draft. Saves validate the graph and invalidate earlier review packages.'
        : 'Editing locked: this draft is attested, archived, or metadata editing is disabled.';
    }
    current = draft;
    verification = undefined; clearVerificationConfirmation();
    packagePreparation = undefined;
    resetInspection();
    byId('draft-title').textContent = draft.title;
    byId('draft-state').textContent = `${draft.status} · ${draft.missingAssets.length} missing audio file(s) · NOT server-decoded · Publication status not checked${publishing ? '' : ' (writes disabled; existing public copies remain public)'}`;
    if (byId('review-state')) byId('review-state').textContent = draft.review
      ? reviewLabel(draft.review)
      : 'No administrator attestation recorded.';
    byId('manifest-view').textContent = JSON.stringify(draft.manifest, null, 2);
    byId('manifest-download').href = `${pathFor(draft.id)}/manifest`;
    byId('draft-detail').hidden = false;
    const rows = byId('asset-list');
    rows.replaceChildren();
    for (const [id, asset] of Object.entries(draft.manifest.assets)) {
      const uploaded = draft.uploads.find(item => item.asset_id === id);
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${asset.path.slice(6)} — ${uploaded?.state || 'missing'}${uploaded ? ' (' + uploaded.byte_length + ' bytes)' : ''}`;
      row.append(label);
      if (uploaded?.state === 'uploaded') {
        const link = document.createElement('a');
        link.href = `${pathFor(draft.id)}/assets/${encodeURIComponent(id)}`;
        link.textContent = 'Download private file';
        row.append(' ', link);
      }
      rows.append(row);
    }
    byId('warnings').textContent = draft.warnings.map(item => `${item.path}: ${item.message}`).join('\n') || 'No graph warnings.';
    setBusy(busy);
  }
  async function refreshList() {
    const { drafts } = await api('/api/admin/drafts');
    const list = byId('draft-list');
    list.replaceChildren();
    for (const draft of drafts) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${draft.title} · ${draft.status}`;
      button.addEventListener('click', () => work(async () => {
        if (metadataDirty() && !confirm('Discard unsaved metadata edits and reopen this draft? Copy your edits first if you want to keep them.')) return;
        showDraft(await api(pathFor(draft.id)));
        if (byId('metadata-editor')) byId('metadata-editor').value = JSON.stringify(current.manifest, null, 2);
        await loadPublication();
        status(publishing ? 'Draft loaded. Publication status was read only; no files were copied.' : 'Draft loaded. Publication status was not checked. New publishing writes are disabled; existing public copies remain public.');
      }));
      item.append(button); list.append(item);
    }
    if (!drafts.length) list.textContent = 'No drafts yet.';
  }
  async function work(operation) {
    if (busy) return;
    setBusy(true);
    try { await operation(); } catch (error) { status(error.message); }
    finally { setBusy(false); }
  }
  async function verificationWork(operation) {
    try { await operation(); }
    catch (error) { verification = undefined; clearVerificationConfirmation(); renderVerification(); throw error; }
  }
  async function applyVerification(result) {
    acceptVerification(result);
    if (verification?.state === 'attested') { showDraft(await api(pathFor(current.id))); acceptVerification(result); }
  }
  byId('verification-refresh')?.addEventListener('click', () => work(() => verificationWork(async () => {
    if (!current || metadataDirty()) throw new Error('Open saved metadata before refreshing recheck status.');
    clearVerificationConfirmation(); verification = undefined;
    await applyVerification(await api(`${pathFor(current.id)}/review-verification`));
    status('Recheck status refreshed. No file checks or new approval were requested.');
  })));
  async function startVerification(restart = false) {
    if (!packageEligible() || !reviewReport || !byId('review-confirm').checked) throw new Error('Select your exact successful report and confirm that you personally validated it.');
    const expectedHash = reviewReportSha256;
    const restartId = restart ? verification?.id : null;
    if (restart && (!restartId || !confirm('Discard this unapproved recheck pass and start again? This does not delete audio or recorded attestations.'))) return;
    clearVerificationConfirmation(); verification = undefined;
    const result = await api(`${pathFor(current.id)}/review-verification`, 'POST', JSON.stringify({ report: reviewReport,
      policy: 'gizmagick-local-admin-v1', provenanceConfirmed: true, ...(restartId ? { restartVerificationId: restartId } : {}) }));
    acceptVerification(result);
    if (verification?.reportSha256 !== expectedHash || verification.jobId !== reviewReport.jobId || verification.snapshotSha256 !== reviewReport.snapshotSha256) throw new Error('Verification was started for a different report. Refresh status.');
    byId('review-confirm').checked = false;
    status('Private recheck pass started or resumed. Check each batch, then confirm provenance and batch scope again before attesting.');
  }
  byId('verification-start')?.addEventListener('click', () => work(() => verificationWork(() => startVerification())));
  byId('verification-restart')?.addEventListener('click', () => work(() => verificationWork(() => startVerification(true))));
  byId('verification-next')?.addEventListener('click', () => work(() => verificationWork(async () => {
    if (!packageEligible() || verification?.state !== 'pending' || verification.checkedAssets >= verification.totalAssets
        || (reviewReport && reviewReportSha256 !== verification.reportSha256)) throw new Error('Refresh a pending pass for this exact report before continuing.');
    const expected = verification; clearVerificationConfirmation();
    const result = await api(`${pathFor(current.id)}/review-verification-batch`, 'POST', JSON.stringify({ verificationId: expected.id, offset: expected.checkedAssets }));
    acceptVerification(result);
    if (!verification || verification.id !== expected.id || verification.reportSha256 !== expected.reportSha256
        || verification.snapshotSha256 !== expected.snapshotSha256 || verification.checkedAssets !== Math.min(expected.checkedAssets + 16, expected.totalAssets)
        || verification.state !== 'pending') throw new Error('Recheck identity or batch order changed. Refresh progress before continuing.');
    status('Private files rechecked against the exact package. No approval was recorded; final confirmation remains separate.');
  })));
  byId('verification-confirm')?.addEventListener('change', () => setBusy(busy));
  byId('verification-attest')?.addEventListener('click', () => work(() => verificationWork(async () => {
    if (!packageEligible() || verification?.state !== 'pending' || verification.checkedAssets !== verification.totalAssets
        || verification.expiresAt <= Date.now() / 1000 || verification.firstCheckedAt < Date.now() / 1000 - 300
        || !reviewReport || reviewReportSha256 !== verification.reportSha256 || !byId('review-confirm').checked
        || !byId('verification-confirm').checked) throw new Error('Exact report, complete recent checks and fresh personal-run/batch-window confirmations are required.');
    const expected = verification; clearVerificationConfirmation(); byId('review-confirm').checked = false;
    const result = await api(`${pathFor(current.id)}/attest-review-batched`, 'POST', JSON.stringify({ verificationId: expected.id,
      policy: 'gizmagick-local-admin-v1', provenanceConfirmed: true, batchWindowConfirmed: true }));
    acceptVerification(result);
    if (verification?.id !== expected.id || verification.reportSha256 !== expected.reportSha256 || verification.state !== 'attested') throw new Error('The recorded attestation does not match this pass. Refresh status.');
    clearReview(); await applyVerification(result);
    status('Administrator attestation recorded with recent, separate-batch storage scope. NOT server-decoded; this review type cannot be published yet.');
  })));
  async function packageWork(operation) {
    try { await operation(); }
    catch (error) { packagePreparation = undefined; renderPreparation(); throw error; }
  }
  byId('package-refresh')?.addEventListener('click', () => work(() => packageWork(async () => {
    if (!current || metadataDirty() || current.review) throw new Error('Open an active, saved, unreviewed draft.');
    packagePreparation = undefined;
    acceptPreparation(await api(`${pathFor(current.id)}/review-package-batches`));
    status('Preparation status refreshed. No private file checks, approvals or public writes were requested.');
  })));
  byId('package-start')?.addEventListener('click', () => work(() => packageWork(async () => {
    if (!packageEligible()) throw new Error('Upload every file and save metadata before preparing a package.');
    clearReview(); packagePreparation = undefined;
    acceptPreparation(await api(`${pathFor(current.id)}/review-package-batches`, 'POST', '{}'));
    status('Private package preparation started or resumed. Click for each batch; no approval was recorded.');
  })));
  byId('package-restart')?.addEventListener('click', () => work(() => packageWork(async () => {
    if (!packageEligible() || !packagePreparation) throw new Error('Refresh preparation before restarting.');
    if (!confirm('Discard these package checks and invalidate this preparation’s completed package and reports? Audio will not be deleted.')) return;
    const jobId = packagePreparation.jobId; clearReview(); packagePreparation = undefined;
    acceptPreparation(await api(`${pathFor(current.id)}/review-package-batches`, 'POST', JSON.stringify({ restartJobId: jobId })));
    status('Package checks restarted. Rerun the local validator with the replacement package before attesting.');
  })));
  function downloadPackage(job) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'draft-review-package.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  byId('package-next')?.addEventListener('click', () => work(() => packageWork(async () => {
    if (!packageEligible() || !packagePreparation) throw new Error('Refresh preparation before continuing.');
    const expected = packagePreparation;
    const finishing = expected.checkedAssets === expected.totalAssets;
    const result = await api(`${pathFor(current.id)}/${finishing ? 'review-package-finish' : 'review-package-batch'}`, 'POST',
      JSON.stringify({ jobId: expected.jobId, ...(finishing ? {} : { offset: expected.checkedAssets }) }));
    acceptPreparation(result);
    if (!packagePreparation || packagePreparation.jobId !== expected.jobId
        || packagePreparation.checkedAssets !== (finishing ? expected.totalAssets : Math.min(expected.checkedAssets + 16, expected.totalAssets))) {
      throw new Error('Preparation identity or batch order changed. Refresh its status.');
    }
    if (finishing) {
      const job = result.package;
      if (!packagePreparation.ready || job?.packageVersion !== 1 || job.policy !== 'gizmagick-local-admin-v1'
          || job.jobId !== expected.jobId || job.expiresAt !== packagePreparation.expiresAt || job.snapshot?.draftId !== current.id
          || !Array.isArray(job.snapshot.assets) || job.snapshot.assets.length !== expected.totalAssets
          || job.snapshot.assets.some((asset, index) => {
            const id = Object.keys(current.manifest.assets).sort()[index], uploaded = current.uploads.find(item => item.asset_id === id);
            return asset.assetId !== id || asset.path !== current.manifest.assets[id].path || !uploaded || uploaded.state !== 'uploaded'
              || asset.byteLength !== uploaded.byte_length || asset.sha256 !== uploaded.sha256 || typeof asset.etag !== 'string' || !asset.etag;
          })
          || await digestJSON(job.snapshot.manifest) !== current.manifestSha256 || await digestJSON(job.snapshot) !== job.snapshotSha256) {
        throw new Error('Completed review package does not match this exact draft. Nothing was downloaded or approved.');
      }
      downloadPackage(job);
      status('Review package prepared and download requested. Run the local validator and inspect its report; no approval or publication occurred.');
    } else status('Private package batch recorded. Continue explicitly when ready; no audio approval or publication occurred.');
  })));
  byId('inspection-reset')?.addEventListener('click', () => {
    if (busy) return;
    resetInspection(); setBusy(false);
  });
  byId('inspection-next')?.addEventListener('click', () => work(async () => {
    if (!inspecting || !current || current.status !== 'draft' || current.missingAssets.length || metadataDirty() || inspectionStopped) return;
    try {
      const draft = current, offset = inspectionOffset, total = Object.keys(draft.manifest.assets).length;
      const result = await api(`${pathFor(draft.id)}/storage-inspection?offset=${offset}${inspectionPin ? '&snapshot=' + inspectionPin : ''}`);
      const end = Math.min(offset + 16, total), expectedIds = Object.keys(draft.manifest.assets).sort().slice(offset, end);
      if (current !== draft || metadataDirty() || result.inspectionVersion !== 1 || result.scope !== 'private-storage-batch'
          || result.draftId !== draft.id || result.trackId !== draft.manifest.track.id || result.versionId !== draft.manifest.versionId
          || result.manifestSha256 !== draft.manifestSha256 || !/^[a-f0-9]{64}$/.test(result.allocationSha256)
          || (inspectionPin && result.allocationSha256 !== inspectionPin) || total < 1 || total > 256
          || result.batch?.offset !== offset || result.batch.end !== end || result.batch.totalAssets !== total
          || result.batch.nextOffset !== (end < total ? end : null)
          || result.checksPassed !== true || result.batchOnly !== true || result.pointInTimeOnly !== true
          || result.audioProbed !== false || result.publishing !== false || result.publicationAuthorized !== false
          || !Array.isArray(result.assets) || result.assets.length !== expectedIds.length
          || result.assets.some((asset, index) => {
            const uploaded = draft.uploads.find(item => item.asset_id === expectedIds[index]);
            return asset.assetId !== expectedIds[index] || asset.path !== draft.manifest.assets[expectedIds[index]].path
              || !uploaded || uploaded.state !== 'uploaded' || asset.byteLength !== uploaded.byte_length
              || asset.sha256 !== uploaded.sha256 || typeof asset.etag !== 'string' || !asset.etag;
          })) throw new Error('Inspection response does not match the loaded draft and expected batch.');
      inspectionPin = result.allocationSha256; inspectionOffset = end; inspectionStopped = end === total;
      byId('inspection-progress').max = total; byId('inspection-progress').value = end;
      byId('inspection-results').textContent += result.assets.map(asset => `${asset.path}: ${asset.byteLength} bytes · SHA-256 ${asset.sha256}`).join('\n') + '\n';
      byId('inspection-state').textContent = `${end}/${total} files checked at separate points in time. ${inspectionStopped ? 'Pass finished; NOT approval or permission to publish.' : 'Click to check the next batch.'}`;
      status('Private storage batch checked. No files were decoded, approved or copied publicly.');
    } catch (error) {
      resetInspection('Inspection stopped. Earlier batch results are cleared. Reopen the draft and restart; no approval was recorded.');
      inspectionStopped = true;
      throw error;
    }
  }));
  async function readJSON(input) {
    const file = input.files[0];
    if (!file) throw new Error('Choose the required JSON file(s).');
    if (!file.size || file.size > 262144) throw new Error('Each metadata file must be nonempty and at most 256 KiB.');
    try { return JSON.parse(await file.text()); } catch { throw new Error('A selected metadata file is not valid JSON.'); }
  }
  byId('source').addEventListener('change', () => {
    creationBody = null;
    byId('legacy-fields').hidden = byId('source').value !== 'legacy';
    byId('manifest-fields').hidden = byId('source').value === 'legacy';
  });
  for (const input of document.querySelectorAll('#create-draft input')) input.addEventListener('change', () => { creationBody = null; });
  byId('sections-file').addEventListener('change', () => work(async () => {
    const document = await readJSON(byId('sections-file'));
    const names = Object.keys(document.sections || {});
    if (!names.length) throw new Error('sectionData.json needs a sections object.');
    byId('first-section').replaceChildren(...names.map(name => new Option(name, name)));
    creationBody = null;
    status('Section choices loaded. Check the first section before creating the draft.');
  }));
  byId('first-section').addEventListener('change', () => { creationBody = null; });
  byId('create-draft').addEventListener('submit', event => {
    event.preventDefault();
    work(async () => {
      if (metadataDirty() && !confirm('Creating another draft will discard unsaved metadata edits. Copy or save them first. Continue?')) return;
      if (!creationBody) {
        const input = { requestId: crypto.randomUUID() };
        if (byId('source').value === 'legacy') {
          Object.assign(input, { format: 'legacy', title: byId('title').value.trim(), firstSection: byId('first-section').value,
            simple: byId('simple').checked, test: byId('test-track').checked,
            clipData: await readJSON(byId('clips-file')), sectionData: await readJSON(byId('sections-file')) });
        } else input.manifest = await readJSON(byId('manifest-file'));
        creationBody = JSON.stringify(input);
        if (new TextEncoder().encode(creationBody).length > 262144) { creationBody = null; throw new Error('Combined metadata exceeds 256 KiB.'); }
      }
      showDraft(await api('/api/admin/drafts', 'POST', creationBody));
      await loadPublication();
      await refreshList();
      status('Private draft saved. Its data is not part of the public catalog.');
    });
  });
  function chooseFiles(files) {
    selectedFiles = Array.from(files);
    byId('file-selection').textContent = `${selectedFiles.length} file(s) selected. Files are uploaded one at a time; maximum 16 MiB each.`;
    setBusy(busy);
  }
  byId('audio-files').addEventListener('change', event => chooseFiles(event.target.files));
  byId('drop-zone').addEventListener('dragover', event => { event.preventDefault(); });
  byId('drop-zone').addEventListener('drop', event => {
    event.preventDefault();
    if (!busy) chooseFiles(event.dataTransfer.files);
  });
  byId('upload').addEventListener('click', () => work(async () => {
    if (metadataDirty()) throw new Error('Save or discard unsaved metadata edits before uploading audio.');
    if (!current || current.status !== 'draft' || current.review) throw new Error('Only active, unreviewed private drafts can accept audio uploads.');
    const byName = new Map();
    const expected = new Map(Object.entries(current.manifest.assets).map(([id, asset]) => [asset.path.slice(6), id]));
    for (const file of selectedFiles) {
      if (byName.has(file.name)) throw new Error(`Duplicate selected filename: ${file.name}`);
      if (!expected.has(file.name)) throw new Error(`Not referenced by this draft: ${file.name}`);
      if (!file.size || file.size > 16777216) throw new Error(`${file.name}: file must be nonempty and at most 16 MiB.`);
      byName.set(file.name, file);
    }
    for (const [name, file] of byName) {
      status(`Uploading ${name} to private storage…`);
      await api(`${pathFor(current.id)}/assets/${encodeURIComponent(expected.get(name))}`, 'PUT', file);
      showDraft(await api(pathFor(current.id)));
    }
    await loadPublication();
    status(current.missingAssets.length ? 'Files saved privately. Some referenced audio files are still missing.' : 'All referenced files are stored privately. Local administrator review is required; this upload did not publish anything.');
  }));
  byId('archive').addEventListener('click', () => {
    if (!current || !confirm('Archive this draft? Uploads and pending publication will stop. Private files will be retained, not deleted. Already copied public files remain public; published tracks are NOT unpublished.')) return;
    work(async () => {
      await api(`${pathFor(current.id)}/archive`, 'POST');
      showDraft(await api(pathFor(current.id)));
      await loadPublication();
      await refreshList(); status('Draft archived. No files were deleted or unpublished.');
    });
  });
  byId('metadata-editor')?.addEventListener('input', () => { verification = undefined; packagePreparation = undefined; resetInspection(); clearReview(); clearPublicationConfirmation(); publicationReady = false; setBusy(busy); });
  byId('reset-metadata')?.addEventListener('click', () => {
    if (!current || !confirm('Discard unsaved metadata edits? The saved draft will not change.')) return;
    byId('metadata-editor').value = JSON.stringify(current.manifest, null, 2);
    clearReview(); clearPublicationConfirmation(); publicationReady = false; setBusy(busy);
    status('Unsaved edits discarded. The saved private draft is unchanged.');
  });
  byId('save-metadata')?.addEventListener('click', () => work(async () => {
    if (!current?.metadataEditable) throw new Error('This draft cannot be edited. Attested and archived drafts are immutable.');
    let manifest;
    try { manifest = JSON.parse(byId('metadata-editor').value); } catch { throw new Error('Draft manifest JSON is invalid. Your unsaved text has been kept.'); }
    const body = JSON.stringify({ expectedManifestSha256: current.manifestSha256, manifest });
    if (new TextEncoder().encode(body).length > 262144) throw new Error('Metadata request exceeds 256 KiB. Your unsaved text has been kept.');
    clearReview();
    const saved = await api(`${pathFor(current.id)}/metadata`, 'POST', body);
    showDraft(saved);
    byId('metadata-editor').value = JSON.stringify(saved.manifest, null, 2);
    await loadPublication();
    await refreshList();
    status('Private metadata saved. Download a fresh review package and rerun local validation before attesting. Nothing was published.');
  }));
  byId('review-package')?.addEventListener('click', () => work(async () => {
    if (metadataDirty()) throw new Error('Save or discard unsaved metadata edits before requesting a review package.');
    const job = await api(`${pathFor(current.id)}/review-package`, 'POST');
    downloadPackage(job);
    status('Review package downloaded. Run the local validator against its exact private audio files; no approval has been recorded.');
  }));
  byId('review-report')?.addEventListener('change', () => work(async () => {
    clearReview(); byId('review-confirm').checked = false;
    byId('review-summary').textContent = 'No successful report selected.';
    if (metadataDirty()) throw new Error('Save or discard unsaved metadata edits before selecting a report.');
    const report = await readJSON(byId('review-report'));
    if (report.scope !== 'administrator-review-candidate' || report.valid !== true || report.publishing !== false
        || report.draftId !== current.id || report.versionId !== current.manifest.versionId
        || report.manifestSha256 !== current.manifestSha256
        || !Array.isArray(report.errors) || report.errors.length || !report.measurements || typeof report.measurements !== 'object') {
      throw new Error('Choose a successful review-package report for this exact draft. Ordinary local-only reports cannot be attested.');
    }
    byId('review-summary').textContent = `Draft: ${report.draftId}\nVersion: ${report.versionId}\nPackage: ${report.jobId}\nSnapshot SHA-256: ${report.snapshotSha256}\n\n`
      + Object.entries(report.measurements).map(([id, asset]) => `${current.manifest.assets[id]?.path || id}: ${asset.durationSeconds} s · ${asset.codec} · ${asset.channels} channel(s) · ${asset.sampleRate} Hz\n${asset.byteLength} bytes · SHA-256 ${asset.sha256}`).join('\n\n');
    reviewReport = report;
    if (batchReview) reviewReportSha256 = await digestJSON(report);
    status('Inspect the measurements and graph warnings, then confirm that you ran the validator yourself. The server will check the exact package and stored files again.');
  }));
  byId('review-confirm')?.addEventListener('change', () => setBusy(busy));
  byId('attest-review')?.addEventListener('click', () => work(async () => {
    if (metadataDirty() || !reviewReport || !byId('review-confirm').checked) throw new Error('Saved metadata, a report and explicit administrator confirmation are required.');
    if (batchReview && (verification?.state === 'pending' || Object.keys(current.manifest.assets).length > 16)) throw new Error('Use the separate batched attestation controls for this review.');
    await api(`${pathFor(current.id)}/attest-review`, 'POST', JSON.stringify({ report: reviewReport, policy: 'gizmagick-local-admin-v1', provenanceConfirmed: true }));
    reviewReport = null; byId('review-confirm').checked = false;
    showDraft(await api(pathFor(current.id)));
    await loadPublication();
    status('Administrator attestation recorded for the exact private draft. NOT server-decoded. Attestation does not publish files.');
  }));
  byId('publication-refresh')?.addEventListener('click', () => work(async () => {
    if (!current || metadataDirty()) throw new Error('Save or discard metadata edits before refreshing publication status.');
    publication = undefined; publicationReady = false; clearPublicationConfirmation();
    showDraft(await api(pathFor(current.id)));
    await loadPublication();
    status('Publication status refreshed. No copies or catalog changes were requested.');
  }));
  byId('publication-check')?.addEventListener('click', () => work(async () => {
    clearPublicationConfirmation(); publicationReady = false;
    byId('publication-preview').textContent = '';
    if (!publicationEligible() || publication !== null) throw new Error('Refresh status and choose an eligible new-track draft before checking readiness.');
    const preview = await api(`${pathFor(current.id)}/publication-preview`);
    if (preview.checksPassed !== true || preview.draftId !== current.id || preview.versionId !== current.manifest.versionId
        || preview.trackId !== current.manifest.track.id || preview.review?.snapshotSha256 !== current.review.snapshotSha256
        || preview.review?.reportSha256 !== current.review.reportSha256) throw new Error('Readiness response does not match this exact reviewed draft.');
    byId('publication-preview').textContent = `${preview.objects.map(object => `${object.kind}: ${object.key}\n${object.byteLength} bytes · SHA-256 ${object.sha256}`).join('\n\n')}\n\n`
      + (preview.warnings.map(item => `${item.path}: ${item.message}`).join('\n') || 'No graph warnings.');
    publicationReady = true;
    status('Read-only readiness checks passed. Inspect the exact destinations, then confirm if you intend to publish. No files were copied.');
  }));
  byId('publication-confirm')?.addEventListener('change', () => setBusy(busy));
  byId('publication-action')?.addEventListener('click', () => work(async () => {
    if (!publicationWritable() || !byId('publication-confirm').checked) throw new Error('Current publication status and fresh public-exposure confirmation are required.');
    const existing = publication;
    clearPublicationConfirmation(); publicationReady = false;
    if (!existing && !publicationRequest) publicationRequest = { requestId: crypto.randomUUID(),
      expectedSnapshotSha256: current.review.snapshotSha256, expectedReportSha256: current.review.reportSha256, publicationConfirmed: true };
    // An ambiguous response disables all writes. A separate successful GET is
    // required before a human can confirm again; never automatically retry POST.
    publication = undefined;
    status(existing ? existing.nextAction === 'verify-and-commit' ? 'Verifying all copies and committing the catalog publication…'
      : 'Copying one file to public storage… Its bytes may become public before this response arrives.' : 'Rechecking the reviewed draft and recording an intent… No files are copied by this action.');
    try {
      acceptPublication(await api(`${pathFor(current.id)}/${existing ? 'publication-step' : 'publication'}`, 'POST',
        JSON.stringify(existing ? { publicationId: existing.id, publicationConfirmed: true } : publicationRequest)));
      status(publication.state === 'published' ? 'Track published to the catalog. No further publishing steps are available.'
        : existing ? 'One public copy recorded. Confirm again to continue; nothing runs automatically.' : 'Publication intent recorded. No files copied yet. Confirm again to copy the first file publicly.');
    } catch (error) {
      publication = undefined;
      throw new Error(`${error.message}\nA request may have succeeded or copied public bytes despite this error. Refresh publication status before continuing. No automatic retry was made.`);
    }
  }));
  byId('refresh').addEventListener('click', () => work(refreshList));
  setBusy(false);
  work(async () => { await refreshList(); status(publishing ? 'Admin intake is ready. Publishing requires an eligible draft and explicit confirmation for every step.' : 'Private draft intake is ready. Publishing is disabled.'); });
}
