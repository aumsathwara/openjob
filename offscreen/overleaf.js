const OVERLEAF_BASE = 'https://www.overleaf.com';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OVERLEAF_OFFSCREEN_PUSH') {
    (async () => {
      try {
        const result = await doPush(message);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error('[JTA offscreen] push failed:', err);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
  return false;
});

async function fetchCsrf(projectId) {
  const res = await fetch(`${OVERLEAF_BASE}/project/${projectId}`, {
    credentials: 'include',
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`Cannot access project page (HTTP ${res.status}). Are you logged into Overleaf?`);
  }
  const html = await res.text();
  const m = html.match(/name=["']ol-csrfToken["'][^>]*content=["']([^"']+)["']/i) ||
            html.match(/content=["']([^"']+)["'][^>]*name=["']ol-csrfToken["']/i);
  return m ? m[1] : null;
}

function fetchTreeViaSocket(projectId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = io(OVERLEAF_BASE, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: false,
      timeout: 20000,
    });

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { socket.disconnect(); } catch {}
      fn(arg);
    };

    const timer = setTimeout(() => finish(reject, new Error('Realtime connection timed out (20s).')), 25000);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.timeout(30000).emit(
        'joinProject',
        { project_id: projectId, projectId },
        (err, response) => {
          if (err) return finish(reject, new Error('joinProject ack failed/timeout.'));
          const data = Array.isArray(response) ? response[0] : response;
          const project = data && (data.project || data);
          if (!project || !Array.isArray(project.rootFolder)) {
            return finish(reject, new Error('Unexpected joinProject response.'));
          }
          const docs = [];
          const walk = (folder, prefix) => {
            for (const d of folder.docs || []) {
              docs.push({ id: d._id, name: d.name, path: `${prefix}${d.name}` });
            }
            for (const sub of folder.folders || []) walk(sub, `${prefix}${sub.name}/`);
          };
          for (const rf of project.rootFolder) walk(rf, '');
          finish(resolve, {
            rootFolderId: project.rootFolder[0]?._id || null,
            docs,
          });
        }
      );
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      finish(reject, new Error(`Realtime connect failed: ${err.message}`));
    });
  });
}

function pickDoc(docs, filename) {
  const wanted = filename.toLowerCase();
  const stem = wanted.replace(/\.[^.]+$/, '');
  const score = (d) => {
    const name = d.name.toLowerCase();
    if (name === wanted) return d.path.split('/').length;      // exact name, prefer root
    if (name.replace(/\.[^.]+$/, '') === stem) return 100 + d.path.split('/').length;
    return Infinity;
  };
  let best = null, bestScore = Infinity;
  for (const d of docs) {
    const s = score(d);
    if (s < bestScore) { best = d; bestScore = s; }
  }
  return bestScore === Infinity ? null : best;
}

async function updateDoc(projectId, docId, csrf, texText) {
  const res = await fetch(`${OVERLEAF_BASE}/project/${projectId}/doc/${docId}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf || '',
    },
    body: JSON.stringify({ newDoc: texText }),
  });
  if (!res.ok) {
    throw new Error(`Doc update failed (HTTP ${res.status}). Close the file in Overleaf if it is open, then retry.`);
  }
}

async function compileAndFetchPdf(projectId, csrf, waitSeconds = 90) {
  try {
    const res = await fetch(`${OVERLEAF_BASE}/project/${projectId}/compile`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' },
      body: JSON.stringify({ draft: false, stopOnFirstError: true }),
    });
    const data = await res.json().catch(() => ({}));
    const pdfUrl = data.pdfDownloadUrl;
    if (pdfUrl) {
      const full = pdfUrl.startsWith('http') ? pdfUrl : `${OVERLEAF_BASE}${pdfUrl}`;
      const pdfRes = await fetch(full, { credentials: 'include' });
      if (pdfRes.ok && (pdfRes.headers.get('content-type') || '').startsWith('application/pdf')) {
        return await blobToB64(await pdfRes.blob());
      }
    }
  } catch {}

  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(
        `${OVERLEAF_BASE}/download/project/${projectId}/build/latest/output/output.pdf`,
        { credentials: 'include' }
      );
      if (res.ok && (res.headers.get('content-type') || '').startsWith('application/pdf')) {
        return await blobToB64(await res.blob());
      }
    } catch {}
  }
  return null;
}

async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function doPush({ projectId, texText, filename, fetchPdf }) {
  if (!projectId) throw new Error('No target project configured.');

  const csrf = await fetchCsrf(projectId);
  const tree = await fetchTreeViaSocket(projectId);
  const doc = pickDoc(tree.docs, filename || 'main.tex');
  if (!doc) {
    const listing = tree.docs.slice(0, 15).map((d) => d.path).join(', ') || '(none)';
    throw new Error(`'${filename}' not found in project. Docs: ${listing}`);
  }

  await updateDoc(projectId, doc.id, csrf, texText);

  let pdfB64 = null;
  if (fetchPdf !== false) {
    pdfB64 = await compileAndFetchPdf(projectId, csrf);
  }

  return {
    mode: 'updated',
    doc_name: doc.path,
    pdf_b64: pdfB64,
  };
}
