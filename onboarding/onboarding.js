const SERVER_URL = 'http://127.0.0.1:8000';

const ENTRY_TYPES = ['experience', 'project', 'skill', 'education', 'summary', 'general'];

const pendingFiles = [];

document.addEventListener('DOMContentLoaded', () => {
  const serverBadge = document.getElementById('server-status');
  const fileDrop = document.getElementById('file-drop');
  const fileInput = document.getElementById('file-input');
  const fileList = document.getElementById('file-list');
  const entriesContainer = document.getElementById('entries-container');
  const addEntryBtn = document.getElementById('add-entry-btn');
  const saveAllBtn = document.getElementById('save-all-btn');
  const reloadBtn = document.getElementById('reload-btn');
  const statusDiv = document.getElementById('status');

  function setStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = `status-${type}`;
    statusDiv.style.display = 'block';
  }

  async function checkServer() {
    try {
      const res = await fetch(`${SERVER_URL}/`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      serverBadge.textContent = `Server Online — ${data.profile_entries} profile entries`;
      serverBadge.className = 'server-badge online';
      return true;
    } catch {
      serverBadge.textContent = 'Backend Offline — run: python backend/server.py';
      serverBadge.className = 'server-badge';
      return false;
    }
  }

  // --- File upload handling ---
  fileDrop.addEventListener('click', () => fileInput.click());
  fileDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDrop.classList.add('dragover');
  });
  fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
  fileDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDrop.classList.remove('dragover');
    addFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  function addFiles(files) {
    for (const f of files) {
      if (pendingFiles.some((p) => p.name === f.name && p.size === f.size)) continue;
      pendingFiles.push(f);
    }
    renderFileList();
  }

  function renderFileList() {
    fileList.innerHTML = '';
    pendingFiles.forEach((f, idx) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', () => {
        pendingFiles.splice(idx, 1);
        renderFileList();
      });
      li.appendChild(nameSpan);
      li.appendChild(removeBtn);
      fileList.appendChild(li);
    });
  }

  async function readFileAsB64(file) {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function readFileAsText(file) {
    return await file.text();
  }

  // --- Manual entries UI ---
  function createEntryRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'entry-row';

    const top = document.createElement('div');
    top.className = 'entry-top';

    const typeWrap = document.createElement('div');
    typeWrap.className = 'field';
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type';
    const typeSelect = document.createElement('select');
    ENTRY_TYPES.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      typeSelect.appendChild(opt);
    });
    typeSelect.value = entry.type || 'experience';
    typeWrap.appendChild(typeLabel);
    typeWrap.appendChild(typeSelect);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'field';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Title';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'e.g. Job Tracker AI, Software Engineer at Acme';
    titleInput.value = entry.title || '';
    titleWrap.appendChild(titleLabel);
    titleWrap.appendChild(titleInput);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => row.remove());

    top.appendChild(typeWrap);
    top.appendChild(titleWrap);
    top.appendChild(removeBtn);

    const contentWrap = document.createElement('div');
    contentWrap.className = 'field';
    const contentLabel = document.createElement('label');
    contentLabel.textContent = 'Description';
    const contentArea = document.createElement('textarea');
    contentArea.placeholder = entry.content ? '' :
      'What did you build/do? Tech stack, metrics, outcomes, your role...';
    contentArea.value = entry.content || '';
    contentWrap.appendChild(contentLabel);
    contentWrap.appendChild(contentArea);

    row.appendChild(top);
    row.appendChild(contentWrap);
    return row;
  }

  addEntryBtn.addEventListener('click', () => {
    entriesContainer.appendChild(createEntryRow());
  });

  // First empty row by default
  entriesContainer.appendChild(createEntryRow());

  // --- Save / load ---
  saveAllBtn.addEventListener('click', async () => {
    if (!(await checkServer())) {
      setStatus('Cannot save — local backend is offline. Start it with: python backend/server.py', 'error');
      return;
    }

    saveAllBtn.disabled = true;
    setStatus('Preparing profile data...', 'info');

    try {
      const structured = {};
      const fieldMap = {
        'f-name': 'full_name',
        'f-email': 'email',
        'f-phone': 'phone',
        'f-location': 'location',
        'f-linkedin': 'linkedin',
        'f-github': 'github',
        'f-website': 'website',
      };
      for (const [id, key] of Object.entries(fieldMap)) {
        const val = document.getElementById(id).value.trim();
        if (val) structured[key] = val;
      }

      const entries = [];
      entriesContainer.querySelectorAll('.entry-row').forEach((row) => {
        const type = row.querySelector('select').value;
        const title = row.querySelector('input').value.trim();
        const content = row.querySelector('textarea').value.trim();
        if (title || content) entries.push({ type, title, content });
      });

      const files = [];
      for (const f of pendingFiles) {
        setStatus(`Reading ${f.name}...`, 'info');
        if (f.name.toLowerCase().endsWith('.pdf')) {
          files.push({ filename: f.name, content_b64: await readFileAsB64(f) });
        } else {
          files.push({ filename: f.name, content_text: await readFileAsText(f) });
        }
      }

      if (!Object.keys(structured).length && !entries.length && !files.length) {
        throw new Error('Nothing to save — fill in at least one section.');
      }

      setStatus('Saving to ChromaDB...', 'info');
      const res = await fetch(`${SERVER_URL}/profile/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structured, entries, files }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to import profile.');
      }

      const data = await res.json();
      setStatus(`Profile saved! ${data.entries_added} entries indexed (${data.total_profile_entries} total).`, 'success');
      await loadSavedEntries();
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Error saving profile.', 'error');
    } finally {
      saveAllBtn.disabled = false;
    }
  });

  async function loadSavedEntries() {
    try {
      const res = await fetch(`${SERVER_URL}/profile`);
      if (!res.ok) throw new Error('Failed to load profile.');
      const data = await res.json();

      const fields = data.fields || {};
      const fieldMap = {
        full_name: 'f-name',
        email: 'f-email',
        phone: 'f-phone',
        location: 'f-location',
        linkedin: 'f-linkedin',
        github: 'f-github',
        website: 'f-website',
      };
      for (const [key, id] of Object.entries(fieldMap)) {
        if (fields[key]) document.getElementById(id).value = fields[key];
      }

      document.getElementById('saved-count').textContent = data.count;

      const list = document.getElementById('saved-entries');
      list.innerHTML = '';
      if (!data.entries.length) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="empty-note">No entries yet — complete the sections above and click Save Profile.</span>';
        list.appendChild(li);
        return;
      }

      for (const entry of data.entries) {
        const li = document.createElement('li');

        const badge = document.createElement('span');
        badge.className = 'saved-type-badge';
        badge.textContent = entry.entry_type || 'general';

        const textWrap = document.createElement('div');
        const titleSpan = document.createElement('span');
        titleSpan.className = 'saved-title';
        titleSpan.textContent = entry.title || 'Untitled';
        const previewSpan = document.createElement('span');
        previewSpan.className = 'saved-preview';
        previewSpan.textContent = (entry.content || '').slice(0, 140) +
          ((entry.content || '').length > 140 ? '\u2026' : '');
        textWrap.appendChild(titleSpan);
        textWrap.appendChild(previewSpan);

        const delBtn = document.createElement('button');
        delBtn.className = 'delete-entry';
        delBtn.textContent = '\u00d7';
        delBtn.addEventListener('click', async () => {
          await fetch(`${SERVER_URL}/profile/entry/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
          await loadSavedEntries();
          checkServer();
        });

        li.appendChild(badge);
        li.appendChild(textWrap);
        li.appendChild(delBtn);
        list.appendChild(li);
      }
    } catch (err) {
      console.error(err);
    }
  }

  reloadBtn.addEventListener('click', async () => {
    await loadSavedEntries();
    setStatus('Saved data loaded.', 'info');
  });

  // --- Overleaf session check + target project ---
  async function loadSavedOverleafTarget() {
    const { overleafProjectId } = await chrome.storage.local.get('overleafProjectId');
    if (overleafProjectId) {
      document.getElementById('f-overleaf-project-manual').value = overleafProjectId;
      const note = document.getElementById('overleaf-saved-note');
      note.style.display = 'inline';
      note.textContent = 'Saved: ' + overleafProjectId;
    }
  }

  document.getElementById('overleaf-check-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    setStatus('Checking Overleaf session...', 'info');
    try {
      const response = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: 'OVERLEAF_STATUS' }, resolve));
      if (!response.ok) throw new Error(response.error);
      const projects = response.data.projects || [];
      const debug = response.data.debug || {};
      setStatus(`Overleaf connected! ${projects.length} projects found.` +
        (projects[0] ? ` Most recent: "${projects[0].name}"` : '') +
        (projects.length === 0 && debug.strategy ? ` (lookup via: ${debug.strategy})` : ''), 'success');

      // Always show target section - manual URL entry works even if listing failed
      const wrap = document.getElementById('overleaf-target-wrap');
      const select = document.getElementById('f-overleaf-project');
      select.innerHTML = '<option value="">Select a project...</option>';
      for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || '(untitled)';
        select.appendChild(opt);
      }
      if (!projects.length) {
        const opt = document.createElement('option');
        opt.textContent = '(no projects auto-detected - paste URL below)';
        opt.disabled = true;
        select.appendChild(opt);
        if (debug.meta_names?.length) {
          console.log('[Overleaf] page meta tags:', debug.meta_names);
        }
      }
      const { overleafProjectId } = await chrome.storage.local.get('overleafProjectId');
      if (overleafProjectId) {
        const match = projects.find((p) => p.id === overleafProjectId);
        if (match) select.value = overleafProjectId;
      }
      wrap.style.display = 'block';
    } catch (err) {
      setStatus(err.message || 'Overleaf check failed.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('overleaf-save-project-btn').addEventListener('click', () => {
    const selectVal = document.getElementById('f-overleaf-project').value;
    const manualVal = document.getElementById('f-overleaf-project-manual').value.trim();
    const chosen = manualVal || selectVal;
    if (!chosen) {
      setStatus('Select a project from the list or paste a project URL first.', 'error');
      return;
    }
    chrome.storage.local.set({ overleafProjectId: chosen }, () => {
      const note = document.getElementById('overleaf-saved-note');
      note.style.display = 'inline';
      note.textContent = 'Saved: ' + chosen;
      setStatus('Overleaf target project saved. Tailored resumes will now update this project in place.', 'success');
    });
  });

  checkServer();
  loadSavedEntries();
  loadSavedOverleafTarget();
});
