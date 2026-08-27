document.addEventListener('DOMContentLoaded', () => {
    const extractBtn = document.getElementById('extract-btn');
    const summarizeBtn = document.getElementById('summarize-btn');
    const sendChatBtn = document.getElementById('send-chat-btn');
    const chatInput = document.getElementById('chat-input');
    const chatBox = document.getElementById('chat-box');
    const summaryBox = document.getElementById('summary-box');
    const modelInput = document.getElementById('ollama-model');

    const statusDiv = document.getElementById('status');
    const previewContainer = document.getElementById('preview-container');
    const markdownPreview = document.getElementById('markdown-preview');
    const serverBadge = document.getElementById('server-status');
    const autofillBtn = document.getElementById('autofill-btn');
    const openOnboardingBtn = document.getElementById('open-onboarding-btn');
    const tailorBtn = document.getElementById('tailor-btn');
    const tailorJobSelect = document.getElementById('tailor-job-select');
    const tailorResult = document.getElementById('tailor-result');
    const tailorPreview = document.getElementById('tailor-preview');
    const tailorDownloads = document.getElementById('tailor-downloads');
    const downloadTexBtn = document.getElementById('download-tex-btn');
    const downloadPdfBtn = document.getElementById('download-pdf-btn');
    const pushOverleafBtn = document.getElementById('push-overleaf-btn');

    let lastTailored = { tex: null, pdf: null, content: '' };

    const SERVER_URL = 'http://127.0.0.1:8000';

    // Request host permission for a site on first use (optional <all_urls>)
    async function ensureOriginPermission(origin) {
        if (!origin || origin === 'chrome://') return false;
        try {
            const has = await chrome.permissions.contains({ origins: [origin] });
            if (has) return true;
            return await chrome.permissions.request({ origins: [origin] });
        } catch (err) {
            console.error('Permission request failed:', err);
            return false;
        }
    }

    async function originForTab(tab) {
        try {
            const url = new URL(tab.url);
            return url.origin + '/*';
        } catch {
            return null;
        }
    }

    // Model selection persistence
    async function restoreModel() {
        const { ollamaModel } = await chrome.storage.local.get('ollamaModel');
        if (ollamaModel) modelInput.value = ollamaModel;
    }
    modelInput.addEventListener('change', () => {
        chrome.storage.local.set({ ollamaModel: modelInput.value.trim() });
    });
    restoreModel();

    // Tab Navigation Logic
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    function setStatus(message, type = 'info') {
        statusDiv.textContent = message;
        statusDiv.className = `status-${type}`;
        statusDiv.style.display = 'block';
    }

    // Check ChromaDB Local Server connection
    async function checkServerStatus() {
        try {
            const res = await fetch(`${SERVER_URL}/`);
            if (res.ok) {
                const data = await res.json();
                serverBadge.textContent = `Online (${data.total_jobs} indexed)`;
                serverBadge.className = 'server-badge online';
            } else {
                throw new Error();
            }
        } catch {
            serverBadge.textContent = 'Server Offline';
            serverBadge.className = 'server-badge';
        }
    }

    checkServerStatus();

    // 1. Index Page Logic
    extractBtn.addEventListener('click', async () => {
        extractBtn.disabled = true;
        setStatus('Extracting page content...', 'info');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.id) {
                throw new Error('No active tab found.');
            }

            if (!(await ensureOriginPermission(await originForTab(tab)))) {
                throw new Error('Site access denied - cannot read this page.');
            }

            const [results] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: extractJobDetails
            });

            if (!results || !results.result) {
                throw new Error('Could not extract details from this page.');
            }

            const { title, company, location, url, bodyHtml, rawText } = results.result;

            let markdownBody = '';
            if (typeof TurndownService !== 'undefined') {
                const turndownService = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
                markdownBody = turndownService.turndown(bodyHtml || rawText);
            } else {
                markdownBody = rawText;
            }

            const markdownDocument = `# ${title || 'Job Description'}\n\n` +
                `**Company:** ${company || 'Unknown'}\n` +
                `**Location:** ${location || 'N/A'}\n` +
                `**Source URL:** [${url}](${url})\n` +
                `**Extracted Date:** ${new Date().toISOString().split('T')[0]}\n\n` +
                `---\n\n` +
                `## Job Description\n\n` +
                `${markdownBody}\n`;

            markdownPreview.value = markdownDocument;
            previewContainer.style.display = 'block';

            setStatus('Indexing into Ephemeral ChromaDB...', 'info');

            const response = await fetch(`${SERVER_URL}/add-job`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title || 'Job Description',
                    company: company || 'Unknown',
                    location: location || 'N/A',
                    url: url,
                    markdown_content: markdownDocument
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || 'Failed to index document in ChromaDB server.');
            }

            const resData = await response.json();
            const msg = resData.is_update 
                ? `Updated existing entry in ChromaDB! (Total: ${resData.total_indexed})` 
                : `Saved to ChromaDB! (Total: ${resData.total_indexed})`;
            setStatus(msg, 'success');
            checkServerStatus();
        } catch (err) {
            console.error(err);
            setStatus(err.message || 'Failed to extract or send job description.', 'error');
        } finally {
            extractBtn.disabled = false;
        }
    });

    // Helper function to create Thinking Orb & Collapsible Reasoning Container UI
    function createThinkingUI(parentContainer) {
        const orbWrapper = document.createElement('div');
        orbWrapper.className = 'thinking-orb-wrapper';
        orbWrapper.innerHTML = `
            <div class="thinking-orb"></div>
            <span class="orb-label">Thinking... (click to expand)</span>
        `;

        const reasoningBox = document.createElement('div');
        reasoningBox.className = 'reasoning-container';

        const answerBox = document.createElement('div');
        answerBox.className = 'answer-container';

        orbWrapper.addEventListener('click', () => {
            const isExpanded = reasoningBox.classList.toggle('expanded');
            const orbLabel = orbWrapper.querySelector('.orb-label');
            if (orbLabel) {
                orbLabel.textContent = isExpanded ? 'Hide reasoning' : 'Show reasoning';
            }
        });

        parentContainer.appendChild(orbWrapper);
        parentContainer.appendChild(reasoningBox);
        parentContainer.appendChild(answerBox);

        return { orbWrapper, reasoningBox, answerBox };
    }

    // 2. Summarize Logic (Streaming with Thinking Orb)
    summarizeBtn.addEventListener('click', async () => {
        summarizeBtn.disabled = true;
        setStatus('Generating AI summary via Ollama...', 'info');
        summaryBox.innerHTML = '';
        summaryBox.style.display = 'block';

        const { orbWrapper, reasoningBox, answerBox } = createThinkingUI(summaryBox);
        let buffer = '';

        try {
            const modelName = modelInput.value.trim() || 'qwen2.5:1.5b';
            const response = await fetch(`${SERVER_URL}/summarize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || 'Failed to generate summary.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                // The last element is either empty string (if ends with \n) or an incomplete line
                buffer = lines.pop(); 

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.type === 'thinking') {
                            reasoningBox.textContent += data.text;
                        } else if (data.type === 'content') {
                            answerBox.textContent += data.text;
                            // Once answer starts, update orb label
                            const label = orbWrapper.querySelector('.orb-label');
                            if (label && label.textContent.includes('Thinking...')) {
                                label.textContent = 'Thought complete (click to view)';
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse JSON chunk:', line);
                    }
                }
                summaryBox.scrollTop = summaryBox.scrollHeight;
            }

            setStatus('Summary generated successfully!', 'success');
        } catch (err) {
            console.error(err);
            setStatus(err.message || 'Error generating summary with Ollama.', 'error');
        } finally {
            summarizeBtn.disabled = false;
        }
    });

    // 3. RAG Chat Logic (Streaming with Thinking Orb)
    async function handleSendChat() {
        const query = chatInput.value.trim();
        if (!query) return;

        chatInput.value = '';
        appendChatMessage(query, 'user');
        sendChatBtn.disabled = true;

        const assistantMsgEl = document.createElement('div');
        assistantMsgEl.className = 'chat-msg assistant';
        chatBox.appendChild(assistantMsgEl);

        const { orbWrapper, reasoningBox, answerBox } = createThinkingUI(assistantMsgEl);
        let buffer = '';

        try {
            const modelName = modelInput.value.trim() || 'qwen2.5:1.5b';
            const response = await fetch(`${SERVER_URL}/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: query, model: modelName })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || 'Error communicating with Ollama RAG.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.type === 'thinking') {
                            reasoningBox.textContent += data.text;
                        } else if (data.type === 'content') {
                            answerBox.textContent += data.text;
                            const label = orbWrapper.querySelector('.orb-label');
                            if (label && label.textContent.includes('Thinking...')) {
                                label.textContent = 'Thought complete (click to view)';
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse JSON chunk:', line);
                    }
                }
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        } catch (err) {
            console.error(err);
            answerBox.textContent = `Error: ${err.message}`;
        } finally {
            sendChatBtn.disabled = false;
        }
    }

    sendChatBtn.addEventListener('click', handleSendChat);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSendChat();
    });

    // 4. Autofill / Apply Logic
    async function sendToActiveTab(message) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) throw new Error('No active tab found.');

        if (!(await ensureOriginPermission(await originForTab(tab)))) {
            throw new Error('Site access denied.');
        }

        try {
            return await chrome.tabs.sendMessage(tab.id, message);
        } catch {
            // Content script not injected yet - inject then retry once
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/autofill.js']
            });
            return await chrome.tabs.sendMessage(tab.id, message);
        }
    }

    autofillBtn.addEventListener('click', async () => {
        autofillBtn.disabled = true;
        setStatus('Scanning page for application form...', 'info');
        try {
            await sendToActiveTab({ type: 'START_AUTOFILL_SCAN' });
            setStatus('Autofill panel opened on the page.', 'success');
            window.close();
        } catch (err) {
            console.error(err);
            setStatus(err.message.includes('Cannot access')
                ? 'Cannot access this page. Try a normal website tab.'
                : (err.message || 'Autofill failed.'), 'error');
        } finally {
            autofillBtn.disabled = false;
        }
    });

    openOnboardingBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 5. Resume Tailoring Logic
    async function loadJobSelector() {
        try {
            const res = await fetch(`${SERVER_URL}/jobs`);
            if (!res.ok) return;
            const data = await res.json();
            tailorJobSelect.innerHTML = '<option value="">Latest indexed</option>';
            (data.ids || []).forEach((id, i) => {
                const meta = data.metadatas[i];
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = `${meta.title || 'Unknown'} — ${meta.company || 'Unknown'}`;
                tailorJobSelect.appendChild(opt);
            });
        } catch { /* server offline; selector stays default */ }
    }

    function triggerDownload(url, filename) {
        chrome.downloads.download({ url, filename: filename || 'download', saveAs: true });
    }

    tailorBtn.addEventListener('click', async () => {
        tailorBtn.disabled = true;
        tailorResult.style.display = 'block';
        tailorResult.innerHTML = '';
        tailorPreview.value = '';
        tailorDownloads.style.display = 'none';
        setStatus('Tailoring resume via local AI (this can take a minute)...', 'info');

        const { orbWrapper, reasoningBox, answerBox } = createThinkingUI(tailorResult);
        answerBox.remove(); // preview textarea replaces the plain answer box

        let buffer = '';
        let texContent = '';

        try {
            const response = await fetch(`${SERVER_URL}/tailor/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: tailorJobSelect.value || null,
                    model: modelInput.value.trim() || undefined
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || 'Tailoring failed.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.type === 'thinking') {
                            reasoningBox.textContent += data.text;
                        } else if (data.type === 'content') {
                            texContent += data.text;
                            tailorPreview.value = texContent;
                        } else if (data.type === 'warning') {
                            setStatus(data.text, 'error');
                        } else if (data.type === 'saved') {
                            lastTailored = { tex: data.filename, pdf: data.pdf_filename, content: texContent };
                        } else if (data.type === 'error') {
                            throw new Error(data.text);
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) console.error('Bad NDJSON line:', line);
                        else throw e;
                    }
                }
            }

            if (lastTailored.tex) {
                tailorDownloads.style.display = 'block';
                downloadPdfBtn.disabled = !lastTailored.pdf;
                downloadPdfBtn.title = lastTailored.pdf ? '' : 'pdflatex not available or compile failed';
                setStatus(`Saved ${lastTailored.tex}${lastTailored.pdf ? ` + compiled ${lastTailored.pdf}` : ' (.tex only - pdflatex unavailable)'}`, 'success');
            } else {
                setStatus('Model output was not valid LaTeX. Try a stronger model (e.g. qwen2.5:7b).', 'error');
            }
        } catch (err) {
            console.error(err);
            setStatus(err.message || 'Error tailoring resume.', 'error');
        } finally {
            tailorBtn.disabled = false;
        }
    });

    downloadTexBtn.addEventListener('click', () => {
        if (!lastTailored.content) return;
        const blob = new Blob([lastTailored.content], { type: 'application/x-tex' });
        triggerDownload(URL.createObjectURL(blob), lastTailored.tex || 'tailored_resume.tex');
    });

    downloadPdfBtn.addEventListener('click', () => {
        if (!lastTailored.pdf) return;
        triggerDownload(`${SERVER_URL}/output/${encodeURIComponent(lastTailored.pdf)}`, lastTailored.pdf);
    });

    pushOverleafBtn.addEventListener('click', async () => {
        if (!lastTailored.content) return;
        pushOverleafBtn.disabled = true;
        setStatus('Pushing to Overleaf...', 'info');
        try {
            const selectedJob = tailorJobSelect.selectedOptions[0]?.textContent || 'Job';
            const response = await new Promise((resolve) => chrome.runtime.sendMessage({
                type: 'OVERLEAF_PUSH',
                texText: lastTailored.content,
                projectName: `Resume - ${selectedJob}`.slice(0, 60),
                fetchPdf: false
            }, resolve));
            if (!response.ok) throw new Error(response.error);
            const notice = response.data.fallback_notice
              ? ` (in-place update failed: ${response.data.fallback_notice} - created new project instead)`
              : '';
            setStatus(`${response.data.message}${notice}`, 'success');
            if (response.data.url) {
                chrome.tabs.create({ url: response.data.url });
            }
        } catch (err) {
            console.error(err);
            setStatus(err.message || 'Overleaf push failed.', 'error');
        } finally {
            pushOverleafBtn.disabled = false;
        }
    });

    loadJobSelector();

    function appendChatMessage(text, role) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-msg ${role}`;
        msgDiv.textContent = text;
        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
        return msgDiv;
    }
});

// Function executed inside active web page DOM context
function extractJobDetails() {
    const getMeta = (propName) => {
        const el = document.querySelector(`meta[property="${propName}"], meta[name="${propName}"]`);
        return el ? el.getAttribute('content') : null;
    };

    let jsonLdData = null;
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
        try {
            const data = JSON.parse(script.textContent);
            if (data['@type'] === 'JobPosting' || (Array.isArray(data['@graph']) && data['@graph'].some(item => item['@type'] === 'JobPosting'))) {
                jsonLdData = data['@type'] === 'JobPosting' ? data : data['@graph'].find(item => item['@type'] === 'JobPosting');
                break;
            }
        } catch (e) {}
    }

    const titleSelectors = ['h1', '.job-title', '.top-card-layout__title', '[data-automation="job-title"]', '.jobsearch-JobInfoHeader-title'];
    const companySelectors = ['.company-name', '.topcard__org-name-link', '[data-automation="job-company"]', '.jobsearch-InlineCompanyRating-companyHeader', '.app-main .company'];
    const locationSelectors = ['.location', '.topcard__flavor--bullet', '[data-automation="job-location"]', '.jobsearch-JobInfoHeader-subtitle div', '.job_location'];

    let title = jsonLdData?.title || getMeta('og:title') || document.title;
    if (!jsonLdData?.title) {
        for (const selector of titleSelectors) {
            const el = document.querySelector(selector);
            if (el && el.innerText.trim()) { title = el.innerText.trim(); break; }
        }
    }

    let company = jsonLdData?.hiringOrganization?.name || getMeta('og:site_name');
    if (!company) {
        for (const selector of companySelectors) {
            const el = document.querySelector(selector);
            if (el && el.innerText.trim()) { company = el.innerText.trim(); break; }
        }
    }

    let location = '';
    if (jsonLdData?.jobLocation?.address) {
        const addr = jsonLdData.jobLocation.address;
        location = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
    }
    if (!location) {
        for (const selector of locationSelectors) {
            const el = document.querySelector(selector);
            if (el && el.innerText.trim()) { location = el.innerText.trim(); break; }
        }
    }

    const candidates = Array.from(document.querySelectorAll('main, article, [role="main"], .job-details, .job-post, body'));
    let mainContainer = document.body;

    for (const cand of candidates) {
        if (cand !== document.body && cand.innerText.trim().length > 200) {
            mainContainer = cand;
            break;
        }
    }

    const clone = mainContainer.cloneNode(true);
    clone.querySelectorAll('script, style, iframe, noscript, svg, button, input, nav, footer').forEach(node => node.remove());
    clone.querySelectorAll('.similar-jobs, .recommended-jobs, #similar-jobs').forEach(node => node.remove());

    let bodyHtml = clone.innerHTML;
    let rawText = clone.innerText;

    return {
        title: title ? title.replace(/\s+/g, ' ').trim() : 'Job Description',
        company: company ? company.replace(/\s+/g, ' ').trim() : 'Unknown',
        location: location ? location.replace(/\s+/g, ' ').trim() : 'N/A',
        url: window.location.href,
        bodyHtml,
        rawText
    };
}