// Serialized into the nonce-protected admin page. No JWTs or emails in browser
// storage, and no client-side role/ownership decisions.
export function adminClient() {
  const byId = id => document.getElementById(id);
  let current = null, selectedFiles = [], creationBody = null, busy = false, reviewReport = null;
  const publishing = Boolean(byId('publication-panel'));
  // undefined means unknown: no write is allowed until a successful status GET.
  let publication, publicationReady = false, publicationRequest = null;
  let legacyBoundedIntent = false;
  const preparingIntents = Boolean(byId('intent-panel'));
  const copyingIntents = Boolean(byId('intent-copy'));
  const finalizing = Boolean(byId('final-panel'));
  let finalStatus, finalRequest = null;
  function clearFinalConfirmation() { if (finalizing) byId('final-confirm').checked = false; }
  const finalEligible = () => intentEligible() && finalStatus?.publication?.state === 'pending'
    && finalStatus.publication.copiedObjects === finalStatus.publication.totalObjects;
  function renderFinal() {
    if (!finalizing) return;
    const pub = finalStatus?.publication, pass = finalStatus?.verification;
    byId('final-progress').max = pub?.totalObjects || 1;
    byId('final-progress').value = pass?.checkedObjects || 0;
    byId('final-identity').textContent = current ? `Track: ${current.title}\nTrack ID: ${current.manifest.track.id}\nVersion: ${current.manifest.versionId}\nPlan SHA-256: ${pub?.planSha256 || 'Refresh status'}` : '';
    byId('final-state').textContent = finalStatus === undefined ? 'Final status unknown. Refresh before any action. A lost response may have published the catalog entry; nothing resumes automatically.'
      : pub.state === 'published' ? `Published to the catalog at ${pub.publishedAt}. Final checks were recorded in separate batches from ${new Date(pub.finalAudit.checkedFrom * 1000).toISOString()} to ${new Date(pub.finalAudit.checkedUntil * 1000).toISOString()}. All continuation is locked. Archiving does not unpublish this track.`
      : pub.copiedObjects !== pub.totalObjects ? `${pub.copiedObjects}/${pub.totalObjects} copies recorded. Complete public copying before starting final verification.`
      : !pass ? 'All copies recorded. Explicitly start fresh final checks; old readiness and copy receipts are not final verification.'
      : `${pass.checkedObjects}/${pass.totalObjects} objects freshly checked. Pass ${pass.id}\n${pass.recent ? 'Recent at this status read only; catalog publication requires a separate fresh confirmation.' : 'Expired or stale checks. Explicitly restart before publishing.'} Earlier objects are not rechecked at final confirmation; separate batches are not an atomic storage snapshot.`;
  }
  function acceptFinal(result) {
    const pub = result.publication, pass = result.verification, total = Object.keys(current.manifest.assets).length + 1;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, sha = /^[a-f0-9]{64}$/;
    const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;
    if (result.workflowVersion !== 1 || result.catalogCommitEnabled !== true || result.publicationAuthorized !== false
        || result.serverDecoded !== false || result.pointInTimeBatches !== true || !pub || !uuid.test(pub.id)
        || pub.draftId !== current.id || pub.trackId !== current.manifest.track.id || pub.versionId !== current.manifest.versionId
        || !sha.test(pub.planSha256) || pub.totalObjects !== total || total < 2 || total > 257
        || !Number.isInteger(pub.copiedObjects) || pub.copiedObjects < 0 || pub.copiedObjects > total || !['pending', 'published'].includes(pub.state)
        || (pub.state === 'pending' && (pub.publishedAt !== null || pub.finalAudit !== null))
        || (pub.state === 'published' && (pub.copiedObjects !== total || !Number.isFinite(Date.parse(pub.publishedAt))
          || !pub.finalAudit || !uuid.test(pub.finalAudit.passId) || pub.finalAudit.storageCheckScope !== 'bounded-batches'
          || !time(pub.finalAudit.checkedFrom) || !time(pub.finalAudit.checkedUntil) || pub.finalAudit.checkedFrom > pub.finalAudit.checkedUntil))
        || (pass !== null && (!pass || !uuid.test(pass.id) || !uuid.test(pass.requestId) || pass.publicationId !== pub.id
          || pass.planSha256 !== pub.planSha256 || !sha.test(pass.receiptsSha256) || pass.totalObjects !== total
          || !Number.isInteger(pass.checkedObjects) || pass.checkedObjects < 0 || pass.checkedObjects > total
          || (pass.checkedObjects !== total && pass.checkedObjects % 16) || !time(pass.expiresAt) || typeof pass.recent !== 'boolean'
          || (pass.checkedObjects === 0 ? pass.firstCheckedAt !== null || pass.lastCheckedAt !== null
            : !time(pass.firstCheckedAt) || !time(pass.lastCheckedAt) || pass.firstCheckedAt > pass.lastCheckedAt)
          || (pub.state === 'published' && (pass.id !== pub.finalAudit.passId || pass.checkedObjects !== total))))) throw new Error('Final status does not match this exact publication and separate-batch audit. Refresh before continuing.');
    finalStatus = result;
    if (pass) finalRequest = { action: 'start', publicationId: pub.id, expectedPlanSha256: pub.planSha256, requestId: pass.requestId };
    renderFinal();
  }
  let intentStatus, intentRequest = null;
  const intentEligible = () => Boolean(current?.status === 'draft' && current.review && !current.missingAssets.length
    && Object.keys(current.manifest.assets).length <= 256 && !metadataDirty());
  function clearIntentConfirmation() {
    if (preparingIntents) byId('intent-confirm').checked = false;
    if (copyingIntents) byId('intent-copy-confirm').checked = false;
  }
  function renderIntent() {
    if (!preparingIntents) return;
    const prep = intentStatus?.preparation, intent = intentStatus?.intent;
    byId('intent-progress').max = prep?.totalObjects || intent?.totalObjects || 1;
    byId('intent-progress').value = prep?.checkedObjects || intent?.copiedObjects || 0;
    byId('intent-identity').textContent = current ? `Track: ${current.title}\nTrack ID: ${current.manifest.track.id}\nVersion: ${current.manifest.versionId}\nReview SHA-256: ${current.review?.reportSha256 || 'No attestation'}` : '';
    byId('intent-state').textContent = intentStatus === undefined ? 'Intent/copy status unknown. Refresh before any action. Earlier files may already be public; nothing resumes automatically.'
      : intentStatus.legacyPublication ? `An existing legacy publication ${intentStatus.legacyPublication.id} reserves this draft (${intentStatus.legacyPublication.state}). Use the legacy publisher when enabled. Files may already be public; this panel does not replace or undo it.`
      : intent ? `Immutable bounded intent ${intent.id}\n${intent.copiedObjects}/${intent.totalObjects} public copies recorded. Files may be public even when a failed request has no receipt. ${intent.state === 'published' ? `Published to the catalog at ${intent.publishedAt}. Continuation is locked.` : intent.nextAction === 'copy-one-object' ? 'Paused until you explicitly confirm copying one object publicly.' : intent.copiedObjects === intent.totalObjects ? finalizing ? 'All copies recorded. Use the separate final-verification panel before catalog publication.' : 'All copies recorded; final catalog publication is disabled. Catalog continuation is locked.' : 'Public copying is disabled or this draft is archived; continuation is locked.'} Archiving does not remove public files or its identity reservation.`
      : prep ? `${prep.checkedObjects}/${prep.totalObjects} proposed objects checked in separate batches. Preparation ${prep.id}\n${prep.recent ? 'Recent at this status read only; reservation is a separate confirmation.' : 'Expired or stale checks. Explicitly prepare/restart a fresh pass.'} No public copies or catalog changes were made.`
      : 'No bounded preparation or intent. Explicitly prepare this reviewed draft; no public copying is enabled here.';
  }
  function acceptIntent(result) {
    const prep = result.preparation, intent = result.intent, legacy = result.legacyPublication;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, sha = /^[a-f0-9]{64}$/;
    const total = Object.keys(current.manifest.assets).length + 1;
    const canCopy = Boolean(result.publicCopyEnabled && current.status === 'draft' && intent?.state === 'pending' && intent.copiedObjects < total);
    if (result.workflowVersion !== 2 || result.publishing !== false || typeof result.publicCopyEnabled !== 'boolean' || (result.publicCopyEnabled && !copyingIntents)
        || result.catalogCommitEnabled !== false || result.publicationAuthorized !== false || result.serverDecoded !== false
        || result.pointInTimeBatches !== true || [prep, intent, legacy].filter(value => value !== null).length > 1
        || (legacy !== null && (!legacy || !uuid.test(legacy.id) || !['pending', 'published'].includes(legacy.state)))
        || (prep !== null && (!prep || !uuid.test(prep.id) || !uuid.test(prep.requestId) || prep.draftId !== current.id
          || prep.trackId !== current.manifest.track.id || prep.versionId !== current.manifest.versionId
          || prep.manifestSha256 !== current.manifestSha256 || prep.reportSha256 !== current.review?.reportSha256
          || prep.snapshotSha256 !== current.review?.snapshotSha256 || !sha.test(prep.planSha256)
          || prep.totalObjects !== total || total < 2 || total > 257 || !Number.isInteger(prep.checkedObjects)
          || prep.checkedObjects < 0 || prep.checkedObjects > total || (prep.checkedObjects !== total && prep.checkedObjects % 16)
          || !Number.isSafeInteger(prep.expiresAt) || prep.expiresAt < 0 || prep.expiresAt > 8640000000000 || typeof prep.recent !== 'boolean'
          || prep.storageCheckScope !== (current.review?.storageCheckScope || 'single-request')))
        || (intent !== null && (!intent || !uuid.test(intent.id) || intent.draftId !== current.id || intent.trackId !== current.manifest.track.id
          || intent.versionId !== current.manifest.versionId || intent.totalObjects !== total || !sha.test(intent.planSha256)
          || !['pending', 'published'].includes(intent.state) || (intent.state === 'published' && (intent.copiedObjects !== total || !Number.isFinite(Date.parse(intent.publishedAt))))
          || !Number.isInteger(intent.copiedObjects) || intent.copiedObjects < 0 || intent.copiedObjects > total
          || intent.nextAction !== (canCopy ? 'copy-one-object' : null) || intent.continuationBlocked !== !canCopy
          || intent.storageCheckScope !== (current.review?.storageCheckScope || 'single-request')))) throw new Error('Intent status does not match this exact draft and copy-only scope. Refresh before continuing.');
    intentStatus = result;
    if (prep) intentRequest = { action: 'prepare', requestId: prep.requestId, expectedSnapshotSha256: prep.snapshotSha256, expectedReportSha256: prep.reportSha256 };
    renderIntent();
  }
  const inspecting = Boolean(byId('storage-inspection-panel'));
  const batchPackaging = Boolean(byId('package-panel'));
  const batchReview = Boolean(byId('verification-panel'));
  let verification, reviewReportSha256 = null;
  const digestJSON = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
  const reviewLabel = review => `Administrator-attested by ${review.approvedBy} at ${review.approvedAt}. NOT server-decoded. Report SHA-256: ${review.reportSha256}`
    + (review.storageCheckScope === 'bounded-batches' ? `\nPrivate storage checked in separate batches from ${new Date(review.storageCheckedFrom * 1000).toISOString()} to ${new Date(review.storageCheckedUntil * 1000).toISOString()}; not an atomic snapshot. ${finalizing ? 'Publication needs the separate bounded final-verification workflow.' : 'This review type cannot be published yet.'}` : '');
  function clearVerificationConfirmation() { if (batchReview) byId('verification-confirm').checked = false; }
  function renderVerification() {
    if (!batchReview) return;
    byId('verification-progress').max = verification?.totalAssets || 1;
    byId('verification-progress').value = verification?.checkedAssets || 0;
    byId('verification-state').textContent = verification === undefined ? 'Recheck status unknown. Refresh or explicitly start a pass; no new approval may be inferred.'
      : verification === null ? 'No approval recheck pass. Choose your personally validated report and confirm provenance to start.'
      : `${verification.checkedAssets}/${verification.totalAssets} files rechecked. Report SHA-256: ${verification.reportSha256}\nPackage: ${verification.jobId}\nVerification: ${verification.id}\n${verification.state === 'attested' ? `Administrator attestation recorded with point-in-time batch scope. NOT server-decoded; ${finalizing ? 'publishing requires the separate bounded final workflow.' : 'publishing unsupported for this review type.'}` : `Expires: ${new Date(verification.expiresAt * 1000).toISOString()}. Every check must be at most five minutes old at final confirmation. Checking alone grants no approval.`}`;
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
    && !legacyBoundedIntent
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
      : legacyBoundedIntent ? 'A bounded v2 intent reserves this draft. Use the bounded-intent status panel; this legacy publisher cannot copy or commit it.'
      : publication === undefined ? 'Status unknown. Refresh publication status before any write.'
      : published ? `Published to the catalog at ${publication.publishedAt}. ${publication.copiedObjects}/${publication.totalObjects} public copies verified. Archiving does not unpublish this track.`
      : publication ? `Publication intent ${publication.id}\n${publication.copiedObjects}/${publication.totalObjects} public copies recorded. Files may already be public even if a failed copy has no receipt. ${current.status !== 'draft' ? 'Archived: continuation is locked.' : publication.nextAction === 'verify-and-commit' ? 'All copies recorded. Final verification and catalog publication require a separate confirmation.' : 'Paused until you explicitly confirm and copy the next file.'}`
      : current.review?.storageCheckScope === 'bounded-batches' ? 'This review used separate storage batches. The current publisher does not support this review type; public writes are locked.'
      : !publicationEligible() ? 'No publication intent. An active, saved, administrator-attested draft with all audio uploaded and at most 16 audio files is required.'
      : publicationReady ? 'Readiness checks passed at this moment only. Creating an intent copies nothing; later actions recheck the exact review and files.'
      : 'No publication intent. Check readiness before creating one. No public files have been copied by this workflow.';
    if (current) {
      byId('draft-state').textContent = `${current.status} · ${current.missingAssets.length} missing audio file(s) · NOT server-decoded · ${published || finalStatus?.publication?.state === 'published' || intentStatus?.intent?.state === 'published' ? 'Published' : legacyBoundedIntent ? 'Bounded intent reserved; read its final status; files may be public' : publication === undefined ? 'Publication status unknown' : publication ? 'Publication pending; files may be public' : 'NOT published'}`;
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
    if (preparingIntents) {
      const prep = intentStatus?.preparation, available = intentEligible() && intentStatus !== undefined
        && !intentStatus?.intent && !intentStatus?.legacyPublication;
      byId('intent-refresh').disabled = value || !current || metadataDirty();
      byId('intent-prepare').disabled = value || !available;
      byId('intent-restart').disabled = value || !available || !prep;
      byId('intent-next').disabled = value || !available || !prep?.recent || prep.checkedObjects >= prep.totalObjects;
      const ready = available && prep?.recent && prep.checkedObjects === prep.totalObjects && prep.expiresAt > Date.now() / 1000;
      byId('intent-confirm').disabled = value || !ready;
      byId('intent-reserve').disabled = value || !ready || !byId('intent-confirm').checked;
      if (copyingIntents) {
        const canCopy = intentEligible() && intentStatus?.publicCopyEnabled && intentStatus.intent?.nextAction === 'copy-one-object';
        byId('intent-copy-confirm').disabled = value || !canCopy;
        byId('intent-copy').disabled = value || !canCopy || !byId('intent-copy-confirm').checked;
      }
      renderIntent();
    }
    if (finalizing) {
      const eligible = finalEligible(), pass = finalStatus?.verification;
      byId('final-refresh').disabled = value || !current || metadataDirty();
      byId('final-start').disabled = value || !eligible;
      byId('final-restart').disabled = value || !eligible || !pass;
      byId('final-next').disabled = value || !eligible || !pass?.recent || pass.checkedObjects >= pass.totalObjects;
      const ready = eligible && pass?.recent && pass.checkedObjects === pass.totalObjects && pass.expiresAt > Date.now() / 1000;
      byId('final-confirm').disabled = value || !ready;
      byId('final-commit').disabled = value || !ready || !byId('final-confirm').checked;
      renderFinal();
    }
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
    if (!response.ok) throw Object.assign(new Error(`${result.error || 'Request failed'}${result.details ? '\n' + result.details.map(item => item.path + ': ' + item.message).join('\n') : ''}`), { code: result.code });
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
    try { acceptPublication(await api(`${pathFor(current.id)}/publication`)); }
    catch (error) { if (error.code !== 'PUBLICATION_BOUNDED_WORKFLOW') throw error; legacyBoundedIntent = true; renderPublication(); }
  }
  function showDraft(draft) {
    finalStatus = undefined; finalRequest = null; clearFinalConfirmation();
    const metadataChanged = current?.id !== draft.id || current?.manifestSha256 !== draft.manifestSha256;
    legacyBoundedIntent = false; intentStatus = undefined; clearIntentConfirmation();
    if (metadataChanged) intentRequest = null;
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
  async function intentWork(operation) {
    finalStatus = undefined; clearFinalConfirmation();
    try { await operation(); }
    catch (error) {
      intentStatus = undefined; clearIntentConfirmation(); renderIntent();
      throw new Error(`${error.message}\nRefresh intent/copy status before continuing. An interrupted copy may already have made bytes public. No automatic retry was made.`);
    }
  }
  byId('intent-refresh')?.addEventListener('click', () => work(() => intentWork(async () => {
    if (!current || metadataDirty()) throw new Error('Open saved metadata before reading intent status.');
    clearIntentConfirmation(); intentStatus = undefined;
    acceptIntent(await api(`${pathFor(current.id)}/publication-intent`));
    status('Intent status refreshed. No readiness batches, public copies or catalog changes were requested.');
  })));
  async function prepareIntent(restart = false) {
    if (!intentEligible() || intentStatus === undefined || intentStatus.intent || intentStatus.legacyPublication) throw new Error('Refresh status and select an eligible reviewed new-track draft.');
    const old = intentStatus.preparation;
    if (restart && (!old || !confirm('Discard these readiness checks and start a new preparation? This does not remove an intent, audio or public files.'))) return;
    if (!intentRequest || restart) intentRequest = { action: 'prepare', requestId: old?.requestId || crypto.randomUUID(),
      expectedSnapshotSha256: current.review.snapshotSha256, expectedReportSha256: current.review.reportSha256 };
    clearIntentConfirmation();
    acceptIntent(await api(`${pathFor(current.id)}/publication-intent`, 'POST', JSON.stringify({ ...intentRequest,
      ...(restart ? { restartPreparationId: old.id } : {}) })));
    status('Bounded readiness preparation saved. No public objects or catalog entries were written.');
  }
  byId('intent-prepare')?.addEventListener('click', () => work(() => intentWork(() => prepareIntent())));
  byId('intent-restart')?.addEventListener('click', () => work(() => intentWork(() => prepareIntent(true))));
  byId('intent-next')?.addEventListener('click', () => work(() => intentWork(async () => {
    const prep = intentStatus?.preparation;
    if (!intentEligible() || !prep?.recent || prep.checkedObjects >= prep.totalObjects) throw new Error('Refresh or restart a current readiness preparation.');
    clearIntentConfirmation();
    const result = await api(`${pathFor(current.id)}/publication-intent`, 'POST', JSON.stringify({ action: 'check-batch', preparationId: prep.id, offset: prep.checkedObjects }));
    acceptIntent(result);
    if (intentStatus.preparation?.id !== prep.id || intentStatus.preparation.planSha256 !== prep.planSha256
        || intentStatus.preparation.checkedObjects !== Math.min(prep.checkedObjects + 16, prep.totalObjects)) throw new Error('Readiness identity or batch order changed. Refresh progress.');
    status('Readiness batch checked. No files were copied or published.');
  })));
  byId('intent-confirm')?.addEventListener('change', () => setBusy(busy));
  byId('intent-reserve')?.addEventListener('click', () => work(() => intentWork(async () => {
    const prep = intentStatus?.preparation;
    if (!intentEligible() || !prep?.recent || prep.expiresAt <= Date.now() / 1000 || prep.checkedObjects !== prep.totalObjects
        || !byId('intent-confirm').checked) throw new Error('Complete recent checks and a fresh separate intent confirmation are required.');
    clearIntentConfirmation();
    const result = await api(`${pathFor(current.id)}/publication-intent`, 'POST', JSON.stringify({ action: 'reserve', preparationId: prep.id,
      publicationConfirmed: true, batchWindowConfirmed: true }));
    acceptIntent(result);
    if (intentStatus.intent?.id !== prep.id || intentStatus.intent.planSha256 !== prep.planSha256) throw new Error('The reserved intent does not match this preparation. Refresh its status.');
    legacyBoundedIntent = true; if (publishing) renderPublication();
    status('Immutable bounded intent reserved. No public copy or catalog change occurred. Copying needs a separate confirmation when enabled; final catalog publication remains locked.');
  })));
  byId('intent-copy-confirm')?.addEventListener('change', () => setBusy(busy));
  byId('intent-copy')?.addEventListener('click', () => work(() => intentWork(async () => {
    const intent = intentStatus?.intent;
    if (!intentEligible() || !intentStatus?.publicCopyEnabled || intent?.nextAction !== 'copy-one-object'
        || !byId('intent-copy-confirm').checked) throw new Error('Refresh the exact intent and confirm public exposure before copying one object.');
    clearIntentConfirmation(); intentStatus = undefined;
    status('Conditionally copying one object publicly… Its bytes may become downloadable before this response arrives.');
    acceptIntent(await api(`${pathFor(current.id)}/publication-intent`, 'POST', JSON.stringify({ action: 'copy-one', publicationId: intent.id,
      expectedPlanSha256: intent.planSha256, ordinal: intent.copiedObjects, publicationConfirmed: true })));
    if (intentStatus.intent?.id !== intent.id || intentStatus.intent.planSha256 !== intent.planSha256
        || intentStatus.intent.copiedObjects !== intent.copiedObjects + 1) throw new Error('The returned copy progress changed unexpectedly.');
    status('One public copy recorded. Confirm again for another object; nothing runs automatically. Catalog publication remains locked.');
  })));
  async function finalWork(operation) {
    try { await operation(); }
    catch (error) { finalStatus = undefined; clearFinalConfirmation(); renderFinal();
      throw new Error(`${error.message}\nRefresh final status before continuing. A lost response may have committed the catalog publication. No automatic retry was made.`); }
  }
  byId('final-refresh')?.addEventListener('click', () => work(() => finalWork(async () => {
    if (!current || metadataDirty()) throw new Error('Open saved metadata before reading final status.');
    clearFinalConfirmation(); finalStatus = undefined;
    acceptFinal(await api(`${pathFor(current.id)}/publication-final`));
    status('Final status refreshed. No storage checks, copies or catalog writes were requested.');
  })));
  async function startFinal(restart = false) {
    if (!finalEligible()) throw new Error('Refresh final status for an active reviewed intent with every copy recorded.');
    const pub = finalStatus.publication, pass = finalStatus.verification;
    if (restart && (!pass || !confirm('Discard these final checks and start a fresh pass? No public files, intent or catalog entry will be removed.'))) return;
    if (!finalRequest || restart) finalRequest = { action: 'start', publicationId: pub.id, expectedPlanSha256: pub.planSha256, requestId: pass?.requestId || crypto.randomUUID() };
    clearFinalConfirmation();
    acceptFinal(await api(`${pathFor(current.id)}/publication-final`, 'POST', JSON.stringify({ ...finalRequest, ...(restart ? { restartPassId: pass.id } : {}) })));
    status('Final pass prepared. No storage checks or catalog changes occurred. Check each batch explicitly.');
  }
  byId('final-start')?.addEventListener('click', () => work(() => finalWork(() => startFinal())));
  byId('final-restart')?.addEventListener('click', () => work(() => finalWork(() => startFinal(true))));
  byId('final-next')?.addEventListener('click', () => work(() => finalWork(async () => {
    const pub = finalStatus?.publication, pass = finalStatus?.verification;
    if (!finalEligible() || !pass?.recent || pass.checkedObjects >= pass.totalObjects) throw new Error('Refresh or restart a recent final verification pass.');
    clearFinalConfirmation();
    acceptFinal(await api(`${pathFor(current.id)}/publication-final`, 'POST', JSON.stringify({ action: 'check-batch', publicationId: pub.id,
      expectedPlanSha256: pub.planSha256, passId: pass.id, offset: pass.checkedObjects })));
    if (finalStatus.publication.id !== pub.id || finalStatus.publication.planSha256 !== pub.planSha256
        || finalStatus.verification?.id !== pass.id || finalStatus.verification.receiptsSha256 !== pass.receiptsSha256
        || finalStatus.verification.checkedObjects !== Math.min(pass.checkedObjects + 16, pass.totalObjects)) throw new Error('Final pass identity or batch order changed unexpectedly.');
    status('Private originals and public copies checked for one final batch. No catalog change occurred.');
  })));
  byId('final-confirm')?.addEventListener('change', () => setBusy(busy));
  byId('final-commit')?.addEventListener('click', () => work(() => finalWork(async () => {
    const pub = finalStatus?.publication, pass = finalStatus?.verification;
    if (!finalEligible() || !pass?.recent || pass.checkedObjects !== pass.totalObjects || pass.expiresAt <= Date.now() / 1000
        || !byId('final-confirm').checked) throw new Error('Complete recent final checks and a separate fresh publication confirmation are required.');
    clearFinalConfirmation(); finalStatus = undefined; intentStatus = undefined; clearIntentConfirmation();
    acceptFinal(await api(`${pathFor(current.id)}/publication-final`, 'POST', JSON.stringify({ action: 'commit', publicationId: pub.id,
      expectedPlanSha256: pub.planSha256, passId: pass.id, publicationConfirmed: true, batchWindowConfirmed: true })));
    if (finalStatus.publication.id !== pub.id || finalStatus.publication.planSha256 !== pub.planSha256
        || finalStatus.publication.state !== 'published' || finalStatus.publication.finalAudit.passId !== pass.id) throw new Error('Returned publication does not match this exact final pass.');
    if (preparingIntents) acceptIntent(await api(`${pathFor(current.id)}/publication-intent`));
    status('This exact track/version is published to the catalog. No further publication actions are available.');
  })));
  async function verificationWork(operation) {
    finalStatus = undefined; clearFinalConfirmation();
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
  byId('metadata-editor')?.addEventListener('input', () => { finalStatus = undefined; clearFinalConfirmation(); intentStatus = undefined; clearIntentConfirmation(); verification = undefined; packagePreparation = undefined; resetInspection(); clearReview(); clearPublicationConfirmation(); publicationReady = false; setBusy(busy); });
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
