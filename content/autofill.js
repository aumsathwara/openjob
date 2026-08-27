(() => {
  if (window.__jobTrackerAutofillLoaded) return;
  window.__jobTrackerAutofillLoaded = true;

  const PLATFORMS = [
    {
      id: 'greenhouse',
      test: () => /greenhouse\.io/i.test(location.hostname),
    },
    {
      id: 'lever',
      test: () => /jobs\.lever\.co/i.test(location.hostname),
    },
    {
      id: 'workday',
      test: () => /myworkdayjobs\.com|wd\d+\.myworkday/i.test(location.hostname),
    },
    {
      id: 'ashby',
      test: () => /ashbyhq\.com/i.test(location.hostname),
    },
  ];

  const SEMANTIC_RULES = [
    ['first_name', /\b(first|given)\s*name\b|^first$|\bfname\b/i],
    ['last_name', /\b(last|surname|family)\s*name\b|^last$|\blname\b/i],
    ['full_name', /^(full|your)?\s*name\b|\bfull\s*name\b/i],
    ['email', /\be-?\s*mail\b/i],
    ['phone', /\b(phone|mobile|cell|tel(ephone)?)\b/i],
    ['address', /\b(address|street)(\s*(line)?\s*\d)?\b/i],
    ['city', /\b(city|town|suburb)\b/i],
    ['state', /\b(state|province|region|county)\b/i],
    ['zip', /\b(zip|postal(\s*code)?|post\s*code)\b/i],
    ['country', /\bcountry\b/i],
    ['linkedin', /linked\s*in/i],
    ['github', /git\s*hub/i],
    ['website', /(portfolio|website|personal\s*(web)?site|blog|home\s*page)/i],
    ['school', /\b(school|university|college|institution)\b/i],
    ['degree', /\b(degree|qualification|major)\b/i],
    ['graduation', /graduat/i],
    ['cover_letter', /cover\s*letter/i],
    ['salary', /(salary|compensation|pay)\s*(expectation|requirement)/i],
    ['years_experience', /years?\s*(of\s*)?(practical\s*)?experience/i],
    ['relocation', /relocat/i],
    ['sponsorship', /(sponsorship|visa|work\s*authoriz)/i],
    ['start_date', /(start|availability|notice\s*period)/i],
    ['hear_about', /how\s*did\s*you\s*hear/i],
  ];

  const AI_QUESTION_HINTS = /(why|describe|tell\s*us|explain|what\s*makes|walk\s*us|motivat|strength|weakness|challenge|achiev|experience\s*with|fit|passion|goal|summar)/i;

  function detectPlatform() {
    return PLATFORMS.find((p) => p.test())?.id || 'generic';
  }

  function sendBg(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

  // ---------- Deep DOM helpers (pierce open shadow roots, needed for Workday/Ashby) ----------
  function* walkShadowRoots(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.shadowRoot) {
        yield node.shadowRoot;
        yield* walkShadowRoots(node.shadowRoot);
      }
      node = walker.nextNode();
    }
  }

  function deepQueryAll(selector, root = document) {
    const results = [...root.querySelectorAll(selector)];
    for (const shadow of walkShadowRoots(root)) {
      results.push(...shadow.querySelectorAll(selector));
    }
    return [...new Set(results)];
  }

  // ---------- Field discovery ----------
  function isElementVisible(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function findLabelFor(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping) return wrapping.textContent.trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (ref) return ref.textContent.trim();
    }
    const container = el.closest('[class*="question"], [class*="Question"], fieldset, .form-group, li, [data-automation-id]');
    if (container && container !== document.body) {
      const q = container.querySelector('[class*="label"], [data-automation-id*="label"], legend');
      if (q && !q.contains(el)) return q.textContent.trim();
    }
    let prev = el.previousElementSibling;
    while (prev && prev !== document.body) {
      const txt = prev.textContent.trim();
      if (txt && txt.length < 200) return txt;
      if (txt.length >= 200) break;
      prev = prev.previousElementSibling;
    }
    return '';
  }

  function matchSemantic(text) {
    if (!text) return null;
    for (const [semantic, re] of SEMANTIC_RULES) {
      if (re.test(text)) return semantic;
    }
    return null;
  }

  function deriveSemantic(el, label) {
    const tokens = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('data-automation-id'), el.getAttribute('data-testid')]
      .filter(Boolean).join(' ').replace(/[_\-[\].]/g, ' ');
    return matchSemantic(label) || matchSemantic(tokens);
  }

  function classifyField(el) {
    if (el.type === 'file') {
      const label = findLabelFor(el);
      const semantic = /resume|\bcv\b/i.test(`${label} ${el.name} ${el.id}`) ? 'file_resume' : 'file_other';
      return { kind: 'file', semantic, label: label || 'Upload file', ai: false };
    }
    if (el.type === 'radio' || el.type === 'checkbox') {
      return { kind: 'choice', semantic: null, label: findLabelFor(el), ai: true };
    }
    if (el.tagName === 'SELECT') {
      return { kind: 'select', semantic: null, label: findLabelFor(el), ai: true };
    }
    const label = findLabelFor(el);
    const semantic = deriveSemantic(el, label);
    const isLong = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text' &&
      (el.getAttribute('maxlength') > 200 || AI_QUESTION_HINTS.test(label)));
    if (semantic && !isLong) return { kind: 'text', semantic, label, ai: false };
    if (semantic === 'cover_letter' || semantic === 'salary' || semantic === 'years_experience' ||
        semantic === 'relocation' || semantic === 'sponsorship' || semantic === 'start_date') {
      return { kind: 'text', semantic, label, ai: true };
    }
    const questionText = extractQuestionContext(el) || label;
    if (isLong || AI_QUESTION_HINTS.test(questionText)) {
      return { kind: 'text', semantic: null, label, ai: true };
    }
    if (!semantic) return null; // unmatched short field - leave alone
    return { kind: 'text', semantic, label, ai: false };
  }

  function extractQuestionContext(el) {
    const container = el.closest(
      '[class*="question"], [class*="Question"], fieldset, .application-question, [data-automation-id]'
    );
    if (!container || container === document.body) return '';
    const clone = container.cloneNode(true);
    clone.querySelectorAll('textarea, input, select, button').forEach((n) => n.remove());
    const txt = clone.textContent.replace(/\s+/g, ' ').trim();
    return txt.length <= 400 ? txt : '';
  }

  function discoverFields() {
    const platform = detectPlatform();
    let selectors = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select';
    if (platform === 'workday') {
      selectors = 'input[type="text"], textarea, [data-automation-id] input, [role="textbox"], select';
    }
    const elements = deepQueryAll(selectors).filter((el) => {
      if (el.disabled || el.readOnly) return false;
      if (!isElementVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 20 && rect.height > 8;
    });

    const fields = [];
    const seenRadios = new Set();
    for (const el of elements) {
      const info = classifyField(el);
      if (!info) continue;
      if (el.type === 'radio') {
        const groupKey = `${el.name}|${findRadioGroupLabel(el)}`;
        if (seenRadios.has(groupKey)) continue;
        seenRadios.add(groupKey);
        fields.push({ element: el, groupKey, ...info });
      } else {
        fields.push({ element: el, ...info });
      }
    }
    return { platform, fields };
  }

  function findRadioGroupLabel(radio) {
    const fieldset = radio.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) return legend.textContent.trim();
    }
    return findLabelFor(radio);
  }

  // ---------- Filling ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillTextField(el, value) {
    el.focus();
    setNativeValue(el, value);
    el.blur();
  }

  function fillSelect(el, value) {
    const wanted = String(value).toLowerCase();
    let matched = [...el.options].find((o) =>
      o.value.toLowerCase() === wanted || o.text.toLowerCase().includes(wanted));
    if (!matched && wanted === 'united states') {
      matched = [...el.options].find((o) => /united states|usa|^us$/i.test(o.text));
    }
    if (!matched) return false;
    el.value = matched.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function attachResume(fileInput, statusCb) {
    const res = await sendBg({ type: 'GET_RESUME_FILE' });
    if (!res.ok) throw new Error(res.error);
    const binary = atob(res.data.content_b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const mime = res.data.filename.toLowerCase().endsWith('.pdf')
      ? 'application/pdf' : 'application/octet-stream';
    const file = new File([bytes], res.data.filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    statusCb(`Attached ${res.data.filename}`);
  }

  function highlight(el) {
    const original = el.style.outline;
    el.style.outline = '3px solid #22c55e';
    el.style.transition = 'outline-color 1.2s ease';
    setTimeout(() => { el.style.outline = original; }, 1600);
  }

  // ---------- Review Widget (Shadow DOM) ----------
  const WIDGET_CSS = `
    :host * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .panel { position: fixed; top: 70px; right: 16px; width: 340px; max-height: calc(100vh - 100px);
             display: flex; flex-direction: column; background: #fff; border-radius: 12px;
             box-shadow: 0 10px 40px rgba(15,23,42,.25); border: 1px solid #e2e8f0; z-index: 2147483646; }
    .header { padding: 12px 14px; border-bottom: 1px solid #e2e8f0; display: flex;
              justify-content: space-between; align-items: center; gap: 8px; }
    .header strong { font-size: 13px; color: #0f172a; }
    .platform-badge { font-size: 10px; background: #e0e7ff; color: #3730a3; border-radius: 10px;
                      padding: 2px 8px; font-weight: 700; text-transform: uppercase; }
    .close-btn { background: none; border: none; font-size: 16px; cursor: pointer; color: #64748b; line-height: 1; }
    .body { overflow-y: auto; padding: 10px 14px; flex: 1; }
    .section-title { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
                     color: #64748b; margin: 12px 0 6px; }
    .section-title:first-child { margin-top: 0; }
    .field-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 8px; border-radius: 8px;
                 font-size: 12px; }
    .field-row:hover { background: #f8fafc; }
    .field-row input[type=checkbox] { margin-top: 2px; accent-color: #2563eb; flex-shrink: 0; }
    .field-main { flex: 1; min-width: 0; }
    .field-label { color: #334155; font-weight: 600; word-break: break-word; }
    .field-value { color: #64748b; font-size: 11px; word-break: break-word; margin-top: 2px; }
    .answer-edit { width: 100%; min-height: 54px; margin-top: 4px; padding: 6px 8px; font-size: 12px;
                   border: 1px solid #cbd5e1; border-radius: 6px; resize: vertical; font-family: inherit; }
    .answer-edit:focus { outline: none; border-color: #2563eb; }
    .flag-needs-review { color: #d97706; font-size: 10px; font-weight: 700; }
    .footer { padding: 10px 14px; border-top: 1px solid #e2e8f0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    button.primary { background: #2563eb; color: white; border: none; padding: 9px 12px; border-radius: 8px;
                     font-size: 12px; font-weight: 700; cursor: pointer; }
    button.primary:hover { background: #1d4ed8; }
    button.primary:disabled { background: #94a3b8; cursor: wait; }
    button.secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 9px 12px;
                       border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .status-line { grid-column: span 2; font-size: 11px; color: #64748b; min-height: 14px; }
    .empty-note { font-size: 12px; color: #94a3b8; padding: 8px; }
    .launcher { position: fixed; bottom: 24px; right: 24px; background: #2563eb; color: white; border: none;
                padding: 11px 18px; border-radius: 999px; font-size: 13px; font-weight: 700; cursor: pointer;
                box-shadow: 0 6px 24px rgba(37,99,235,.45); z-index: 2147483646; display: flex; gap: 8px; align-items: center; }
    .launcher:hover { background: #1d4ed8; }
  `;

  let widgetHost = null;
  let launcherHost = null;

  function makeShadowContainer(id) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const host = document.createElement('div');
    host.id = id;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WIDGET_CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return { host, shadow };
  }

  function showLauncher(onClick) {
    const { host, shadow } = makeShadowContainer('__jta-launcher-host');
    launcherHost = host;
    const btn = document.createElement('button');
    btn.className = 'launcher';
    btn.innerHTML = '<span>\u26a1</span> Autofill with AI';
    btn.addEventListener('click', onClick);
    shadow.appendChild(btn);
  }

  function hideLauncher() {
    launcherHost?.remove();
    launcherHost = null;
  }

  function closeWidget() {
    widgetHost?.remove();
    widgetHost = null;
    showLauncher(startAutofill);
  }

  // ---------- Scan + Widget ----------
  let scanResult = null;
  let profileFields = {};

  async function startAutofill() {
    hideLauncher();
    const { shadow } = makeShadowContainer('__jta-widget-host');
    widgetHost = document.getElementById('__jta-widget-host');

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="header">
        <strong>Job Tracker Autofill</strong>
        <span class="platform-badge">${detectPlatform()}</span>
        <button class="close-btn" title="Close">\u00d7</button>
      </div>
      <div class="body"><p class="empty-note">Scanning application form\u2026</p></div>
      <div class="footer">
        <button class="secondary gen-btn">Generate AI Answers</button>
        <button class="primary fill-btn">Fill Selected</button>
        <span class="status-line"></span>
      </div>`;
    shadow.appendChild(panel);

    panel.querySelector('.close-btn').addEventListener('click', closeWidget);
    const bodyEl = panel.querySelector('.body');
    const statusLine = panel.querySelector('.status-line');
    const fillBtn = panel.querySelector('.fill-btn');
    const genBtn = panel.querySelector('.gen-btn');

    const setStatus = (msg) => { statusLine.textContent = msg; };

    const serverPing = await sendBg({ type: 'PING_SERVER' });
    if (!serverPing.ok) {
      bodyEl.innerHTML = '<p class="empty-note">Local backend offline. Start it with:<br><code>python backend/server.py</code></p>';
      return;
    }

    const fieldsRes = await sendBg({ type: 'GET_PROFILE_FIELDS' });
    profileFields = fieldsRes.ok ? fieldsRes.data : {};
    if (!fieldsRes.ok) setStatus(`Warning: ${fieldsRes.error}`);

    scanResult = discoverFields();
    renderScan(bodyEl, scanResult, profileFields, setStatus);

    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      const aiRows = [...bodyEl.querySelectorAll('.answer-edit[data-needs-generation="1"]')];
      for (let i = 0; i < aiRows.length; i++) {
        const row = aiRows[i];
        setStatus(`Answering ${i + 1}/${aiRows.length}: "${row.dataset.shortLabel}"\u2026`);
        row.value = '';
        row.placeholder = 'Thinking\u2026';
        try {
          const res = await sendBg({
            type: 'ANSWER_QUESTION',
            question: row.dataset.question,
          });
          if (res.ok) {
            row.value = res.data.answer;
            row.dataset.needsReview = res.data.needs_review ? '1' : '';
            row.dataset.needsGeneration = '';
            const flag = row.closest('.field-row').querySelector('.flag-needs-review');
            if (res.data.needs_review && !flag) {
              const badge = document.createElement('span');
              badge.className = 'flag-needs-review';
              badge.textContent = 'NEEDS REVIEW';
              row.closest('.field-main').prepend(badge);
            }
          } else {
            row.placeholder = `Error: ${res.error}`;
          }
        } catch (err) {
          row.placeholder = `Error: ${err.message}`;
        }
      }
      setStatus(aiRows.length ? 'Answers ready \u2014 review and edit before filling.' : 'No open questions found.');
      genBtn.disabled = false;
    });

    fillBtn.addEventListener('click', async () => {
      fillBtn.disabled = true;
      let filled = 0, failed = 0;
      const rows = [...bodyEl.querySelectorAll('.field-row')];
      for (let i = 0; i < rows.length; i += 10) {
        await new Promise((r) => requestAnimationFrame(r));
        const batch = rows.slice(i, i + 10);
        batch.forEach((row) => {
          const checkbox = row.querySelector('input[type=checkbox]');
          if (!checkbox.checked) return;
          const record = scanResult.fields[Number(row.dataset.index)];
          if (!record) return;
          try {
            const ok = applyField(record, row, setStatus);
            if (ok) { filled++; highlight(record.element); } else failed++;
          } catch (err) {
            console.warn('[JobTracker] fill error:', err);
            failed++;
          }
        });
      }
      setStatus(`Filled ${filled}${failed ? `, skipped ${failed}` : ''}. Review the form \u2014 nothing was submitted.`);
      fillBtn.disabled = false;
    });
  }

  function applyField(record, row, setStatus) {
    const el = record.element;
    if (record.kind === 'file') {
      if (record.semantic !== 'file_resume') return false;
      attachResume(el, setStatus).catch((err) => setStatus(`Resume attach failed: ${err.message}`));
      return true;
    }
    if (record.ai) {
      const edited = row.querySelector('.answer-edit')?.value.trim();
      if (!edited) return false;
      fillTarget(record, edited);
      return true;
    }
    const value = resolvePersonalValue(record.semantic);
    if (!value) return false;
    fillTarget(record, value);
    return true;
  }

  function fillTarget(record, value) {
    const el = record.element;
    if (record.kind === 'select') {
      fillSelect(el, value);
      return;
    }
    if (el.type === 'radio') {
      const radios = deepQueryAll(`input[type=radio][name="${CSS.escape(el.name)}"]`);
      const match = radios.find((r) =>
        r.value.toLowerCase() === value.toLowerCase() ||
        findLabelFor(r).toLowerCase().includes(value.toLowerCase()));
      if (match) {
        match.checked = true;
        match.dispatchEvent(new Event('input', { bubbles: true }));
        match.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (el.type === 'checkbox') {
      const wantChecked = /^(yes|true|i agree|agree)$/i.test(value);
      if (wantChecked !== el.checked) el.click();
      return;
    }
    fillTextField(el, value);
  }

  function resolvePersonalValue(semantic) {
    const map = {
      first_name: profileFields.full_name?.split(/\s+/)[0] || '',
      last_name: profileFields.full_name?.split(/\s+/).slice(1).join(' ') || '',
      full_name: profileFields.full_name || '',
      email: profileFields.email || '',
      phone: profileFields.phone || '',
      address: profileFields.address || profileFields.location || '',
      city: profileFields.city || '',
      state: profileFields.state || '',
      zip: profileFields.zip || '',
      country: profileFields.country || 'United States',
      linkedin: profileFields.linkedin || '',
      github: profileFields.github || '',
      website: profileFields.website || profileFields.portfolio || '',
      school: profileFields.school || '',
      degree: profileFields.degree || '',
      graduation: profileFields.graduation_year || '',
    };
    return map[semantic] || '';
  }

  function renderScan(bodyEl, result, fields, setStatus) {
    bodyEl.innerHTML = '';
    const { platform, fields: discovered } = result;

    if (!discovered.length) {
      bodyEl.innerHTML = '<p class="empty-note">No application fields detected on this page. Navigate to the actual application form and try again.</p>';
      return;
    }

    const personal = [], attachments = [], aiQuestions = [];
    discovered.forEach((rec, idx) => {
      rec._idx = idx;
      if (rec.kind === 'file') attachments.push(rec);
      else if (rec.ai) aiQuestions.push(rec);
      else personal.push(rec);
    });

    const addSection = (title, records) => {
      if (!records.length) return;
      const t = document.createElement('div');
      t.className = 'section-title';
      t.textContent = title;
      bodyEl.appendChild(t);

      for (const rec of records) {
        const row = document.createElement('div');
        row.className = 'field-row';
        row.dataset.index = rec._idx;

        const cb = document.createElement('input');
        cb.type = 'checkbox';

        const main = document.createElement('div');
        main.className = 'field-main';
        const labelDiv = document.createElement('div');
        labelDiv.className = 'field-label';
        labelDiv.textContent = rec.label || rec.semantic || 'Field';
        main.appendChild(labelDiv);

        if (rec.kind === 'file') {
          const v = document.createElement('div');
          v.className = 'field-value';
          v.textContent = rec.semantic === 'file_resume'
            ? 'Will attach latest resume PDF from your profile'
            : 'Unsupported attachment (skip)';
          main.appendChild(v);
          cb.checked = rec.semantic === 'file_resume';
        } else if (rec.ai) {
          const ta = document.createElement('textarea');
          ta.className = 'answer-edit';
          ta.placeholder = 'Click "Generate AI Answers"';
          ta.dataset.question = extractQuestionContext(rec.element) || rec.label || '';
          ta.dataset.shortLabel = (rec.label || '').slice(0, 40);
          ta.dataset.needsGeneration = '1';
          main.appendChild(ta);
          cb.checked = true;
        } else {
          const val = resolvePersonalValue(rec.semantic);
          const v = document.createElement('div');
          v.className = 'field-value';
          v.textContent = val || '(no data \u2014 will be skipped)';
          main.appendChild(v);
          cb.checked = Boolean(val);
        }

        row.appendChild(cb);
        row.appendChild(main);
        bodyEl.appendChild(row);
      }
    };

    addSection(`Personal Info (${personal.length})`, personal);
    addSection(`Attachments (${attachments.length})`, attachments);
    addSection(`AI Questions (${aiQuestions.length})`, aiQuestions);
    setStatus(`${discovered.length} fields found on ${platform} form.`);
  }

  // Entry points: auto-show launcher on ATS pages; popup triggers startAutofill()
  if (detectPlatform() !== 'generic') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => showLauncher(startAutofill));
    } else {
      showLauncher(startAutofill);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'START_AUTOFILL_SCAN') {
      hideLauncher();
      startAutofill();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
