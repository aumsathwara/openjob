# openjob

**Local-first job application copilot.** Chrome extension + Python backend — everything runs on your machine. No data leaves your device.

- **Scrapes** any job posting → clean markdown
- **Tailors** your LaTeX resume per job with a local LLM (Ollama)
- **Autofills** application forms (Greenhouse / Lever / Workday / Ashby + generic)
- **Answers** open-ended screening questions from your profile (RAG)
- **Pushes** the tailored resume to your Overleaf project via session cookie — or compiles & downloads a PDF locally

> 100% local. ChromaDB + Ollama on `127.0.0.1`. Your resume never leaves your Mac.

---

## One-line install (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/aumsathwara/openjob/main/install.sh | bash
```

What it does:
1. Installs [Homebrew](https://brew.sh) if missing → `python@3.11` + `ollama` via `brew`
2. Creates `.venv`, installs `backend/requirements.txt`
3. Starts Ollama and pulls `qwen2.5:1.5b` (QA) + `qwen2.5:3b` (tailoring)
4. Starts the backend at `http://127.0.0.1:8000`
5. Prints the 30-second Chrome extension steps (see below)

Re-run anytime: `bash ~/openjob/install.sh`

---

## Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select `~/openjob` (the repo root, where `manifest.json` lives)
4. Pin the extension → click its **Options** page to set up your profile

To package a `.zip` for distribution:

```bash
bash package.sh   # → openjob-extension-v1.0.zip
```

---

## Quick start

1. **Profile** — Extension Options → upload your master resume (`.tex` preferred, `.pdf` also works) + add projects / experience entries → Save.
2. **Target Overleaf project** (optional) — On the same page, click *Check Overleaf Session* (you must be logged into overleaf.com in this browser) → pick your resume project → Save. Tailored resumes will overwrite its `main.tex` in place.
3. **Index a job** — Open any job posting → extension popup → *Index Active Page*.
4. **Tailor** — *Tailor* tab → *Tailor Resume for This Job* → Download `.tex` / compiled `PDF`, or *Push to Overleaf*.
5. **Apply** — Open an application form → *Apply* tab → *Autofill Application on This Page* → review the floating panel (personal fields + AI answers + resume attach) → *Fill Selected*. Nothing is ever auto-submitted.

---

## Manual install

```bash
git clone https://github.com/aumsathwara/openjob.git && cd openjob

# Python env
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt

# Ollama (macOS)
brew install ollama
brew services start ollama
ollama pull qwen2.5:1.5b
ollama pull qwen2.5:3b

# Backend
./start.sh          # → http://127.0.0.1:8000  (logs: backend/server.log)
# then load the extension as above
```

Optional for local PDF compilation:

```bash
brew install --cask mactex-no-gui   # provides pdflatex (~4GB)
```

---

## Daily use

| Command | What it does |
|---------|--------------|
| `./start.sh` | Start Ollama (if needed) + backend |
| `./stop.sh`  | Stop backend |
| `bash install.sh` | Update repo, deps, and models |

Backend API is on `http://127.0.0.1:8000` — CORS is locked to `chrome-extension://` origins only.

---

## How it works

```
Chrome popup / content script  ──►  FastAPI (127.0.0.1:8000)  ──►  Ollama (127.0.0.1:11434)
        │                                   │
        │  chrome.cookies (overleaf)   Persistent ChromaDB
        │  for Overleaf session        ├─ profile (resume/projects)
        └──────────────────────────────►└─ job_descriptions
```

- **ATS adapters** for Greenhouse / Lever / Workday / Ashby; generic heuristic fallback for any site.
- **Offscreen document** (`vendor/socket.io.min.js`) talks to Overleaf's realtime service in the browser's authenticated context — falls back to an invisible tab injection, then to a REST `create-new-project` path. Never stores your cookie.
- Tailoring preserves your LaTeX preamble/layout exactly — only bullets and summary are rewritten.

---

## Configuration

- **Ollama models** — Change the model name in the popup's *Ollama Model* field. Defaults: QA `qwen2.5:1.5b`, tailoring `qwen2.5:3b`. The field is persisted via `chrome.storage`.
- **Master resume** — Newest `.tex` in `backend/uploads/` is used. Replace by re-uploading on the Options page.
- **Overleaf target** — Stored in `chrome.storage.local` (`overleafProjectId`). Paste a project URL or pick from the auto-detected list.

---

## Troubleshooting

- **Backend offline** — `cat backend/server.log` and `curl http://127.0.0.1:8000/` health check.
- **Model slow** — First request after boot pays a cold-load cost. Backend pre-warms both models on startup (`keep_alive=30m`). Subsequent answers are ~4s on a 4-core CPU. For Apple Silicon, Ollama will offload to GPU automatically and is much faster.
- **Site access denied** — The extension requests `<all_urls>` on first use per site. Accept the permission prompt.
- **Overleaf 401 / session invalid** — Log into overleaf.com in the same Chrome profile, then *Check Overleaf Session* again.
- **PDF compile fails** — Install MacTeX (`brew install --cask mactex-no-gui`) or use the Overleaf push path, which compiles server-side.

---

## Privacy

- No analytics, no remote calls except to `127.0.0.1` and (when you click Push) `overleaf.com` with your own session cookie.
- ChromaDB lives in `backend/chroma_data/` (gitignored). Delete it to wipe local data.

---

## License

MIT
