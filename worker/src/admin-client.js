// Serialized into the nonce-protected admin page. No JWTs or emails in browser
// storage, and no client-side role/ownership decisions.
export function adminClient() {
  const byId = id => document.getElementById(id);
  let current = null, selectedFiles = [], creationBody = null, busy = false;
  const status = message => { byId('status').textContent = message; };
  const setBusy = value => {
    busy = value;
    for (const control of document.querySelectorAll('button,input,select')) control.disabled = value;
    byId('upload').disabled = value || !current || current.status !== 'draft' || !selectedFiles.length;
    byId('archive').disabled = value || !current || current.status !== 'draft';
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
  function showDraft(draft) {
    if (current?.id !== draft.id) {
      selectedFiles = [];
      byId('audio-files').value = '';
      byId('file-selection').textContent = 'No files selected.';
    }
    current = draft;
    byId('draft-title').textContent = draft.title;
    byId('draft-state').textContent = `${draft.status} · ${draft.missingAssets.length} missing audio file(s) · NOT audio-probed · NOT published`;
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
        showDraft(await api(pathFor(draft.id)));
        status(current.missingAssets.length ? 'Private draft loaded. Choose its missing audio files to continue.' : 'Private draft loaded. All referenced files are stored privately; audio probing and publication are still disabled.');
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
    status(current.missingAssets.length ? 'Files saved privately. Some referenced audio files are still missing.' : 'All referenced files are stored privately. Audio probing and publication are still disabled.');
  }));
  byId('archive').addEventListener('click', () => {
    if (!current || !confirm('Archive this draft? Uploads will stop. Private files will be retained, not deleted.')) return;
    work(async () => {
      await api(`${pathFor(current.id)}/archive`, 'POST');
      showDraft(await api(pathFor(current.id)));
      await refreshList(); status('Draft archived. No files were deleted.');
    });
  });
  byId('refresh').addEventListener('click', () => work(refreshList));
  setBusy(false);
  work(async () => { await refreshList(); status('Private draft intake is ready. Publishing is disabled.'); });
}
