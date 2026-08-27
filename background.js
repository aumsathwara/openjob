const SERVER_URL = 'http://127.0.0.1:8000';
const OVERLEAF_BASE = 'https://www.overleaf.com';

async function serverFetch(path, options = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || `Server error ${res.status}`);
  }
  return res.json();
}

async function getOverleafCookie() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.overleaf.com',
    name: 'overleaf_session2',
  });
  if (!cookie) {
    throw new Error('No Overleaf session found. Log into overleaf.com first.');
  }
  return cookie.value;
}

// ---------- Offscreen document lifecycle ----------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/overleaf.html',
    reasons: ['WORKERS'],
    justification: 'Runs the Overleaf realtime client to push tailored resumes.',
  });
}

function sendMessageWithTimeout(message, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Push timed out.' }), timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'No response from worker.' });
      }
    });
  });
}

async function pushViaOffscreen(projectId, texText, filename, fetchPdf) {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    return { ok: false, error: 'Offscreen API unavailable - using tab fallback.' };
  }
  try {
    await ensureOffscreen();
  } catch (err) {
    return { ok: false, error: `Offscreen setup failed: ${err.message}` };
  }
  return sendMessageWithTimeout({
    type: 'OVERLEAF_OFFSCREEN_PUSH',
    projectId,
    texText,
    filename,
    fetchPdf,
  });
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(new Error('Overleaf page load timed out.'));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(null);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function pushViaTab(projectId, texText, filename, fetchPdf) {
  const tab = await chrome.tabs.create({
    url: `${OVERLEAF_BASE}/project/${projectId}`,
    active: false,
  });
  try {
    const loadErr = await waitForTabComplete(tab.id);
    if (loadErr) return { ok: false, error: loadErr.message };

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['vendor/socket.io.min.js', 'offscreen/overleaf.js'],
    });

    return await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: 'Push timed out.' }),
        180000
      );
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'OVERLEAF_OFFSCREEN_PUSH', projectId, texText, filename, fetchPdf },
        (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: 'No response from worker.' });
          }
        }
      );
    });
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function pushViaBackendCreate(cookie, texText, projectName, filename, fetchPdf) {
  return serverFetch('/overleaf/push', {
    method: 'POST',
    body: JSON.stringify({
      cookie,
      tex_text: texText,
      project_name: projectName || 'Tailored Resume',
      filename: filename || 'main.tex',
      fetch_pdf: fetchPdf !== false,
    }),
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'PING_SERVER': {
          const data = await serverFetch('/');
          sendResponse({ ok: true, data });
          break;
        }
        case 'GET_PROFILE_FIELDS': {
          const data = await serverFetch('/profile/fields');
          sendResponse({ ok: true, data });
          break;
        }
        case 'ANSWER_QUESTION': {
          const data = await serverFetch('/answer/question', {
            method: 'POST',
            body: JSON.stringify({
              question: message.question,
              job_id: message.jobId || null,
              model: message.model || undefined,
              max_results: message.maxResults || undefined,
            }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'GET_RESUME_FILE': {
          const data = await serverFetch('/resume/latest');
          sendResponse({ ok: true, data });
          break;
        }
        case 'GET_OVERLEAF_COOKIE': {
          await getOverleafCookie();
          sendResponse({ ok: true, data: { present: true } });
          break;
        }
        case 'OVERLEAF_STATUS': {
          const cookie = await getOverleafCookie();
          const data = await serverFetch('/overleaf/status', {
            method: 'POST',
            body: JSON.stringify({ cookie }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'OVERLEAF_PUSH': {
          const { overleafProjectId } = await chrome.storage.local.get('overleafProjectId');
          const targetId = message.targetProjectId || overleafProjectId || null;

          // Primary: in-place update via browser-context worker (offscreen, then tab)
          let pushResult = null;
          let pushError = null;
          if (targetId) {
            pushResult = await pushViaOffscreen(
              targetId, message.texText, message.filename || 'main.tex',
              message.fetchPdf !== false);
            if (!pushResult.ok) {
              pushError = pushResult.error;
              try {
                pushResult = await pushViaTab(
                  targetId, message.texText, message.filename || 'main.tex',
                  message.fetchPdf !== false);
              } catch (err) {
                pushError = `${pushError} | tab fallback: ${err.message}`;
                pushResult = { ok: false };
              }
            }
            if (!pushResult.ok) {
              pushError = pushResult.error || pushError;
            }
          } else {
            pushError = 'No target project configured - creating a new project instead.';
          }

          // Fallback: backend REST create-new-project (reliable, verified path)
          if (!pushResult || !pushResult.ok) {
            const cookie = await getOverleafCookie();
            pushResult = await pushViaBackendCreate(
              cookie, message.texText, message.projectName,
              message.filename, message.fetchPdf !== false);
            pushResult.fallback_notice = pushError || undefined;
          }

          // Persist fetched PDF into backend output dir
          if (pushResult.ok && pushResult.pdf_b64) {
            try {
              const saved = await serverFetch('/overleaf/save-pdf', {
                method: 'POST',
                body: JSON.stringify({
                  filename: `overleaf_${(pushResult.project_id || targetId || 'resume').slice(0, 8)}.pdf`,
                  content_b64: pushResult.pdf_b64,
                }),
              });
              pushResult.pdf_filename = saved.filename;
            } catch (err) {
              console.warn('PDF save failed:', err);
            }
          }
          sendResponse({ ok: true, data: pushResult });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});
