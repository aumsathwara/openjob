import os
import sys
import base64
import hashlib
import re
import uuid
import shutil
import subprocess
import socket
import tempfile
import json
from pathlib import Path
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import chromadb

# Ensure backend directory is first in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agents.summarizer_agent import SummarizerAgent
from agents.profile_ingestor import ProfileIngestor, extract_structured_fields
from agents.application_qa_agent import ApplicationQAAgent
from agents.resume_tailor_agent import ResumeTailorAgent
from services.overleaf_client import OverleafClient, OverleafError, build_push_response

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
UPLOADS_DIR = BACKEND_DIR / "uploads"
OUTPUT_DIR = BACKEND_DIR / "output"
DATA_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
PROFILE_FIELDS_PATH = DATA_DIR / "profile_fields.json"

app = FastAPI(title="Job Tracker ChromaDB Server")

# Allow requests only from Chrome Extension pages (extension IDs vary between
# dev and store builds, so match the scheme rather than a fixed ID)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://[a-p0-9]+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Persistent ChromaDB Client (survives server restarts)
chroma_client = chromadb.PersistentClient(path=str(BACKEND_DIR / "chroma_data"))
collection = chroma_client.get_or_create_collection(name="job_descriptions")
profile_collection = chroma_client.get_or_create_collection(name="profile")

OLLAMA_URL = "http://127.0.0.1:11434"
QA_MODEL = "qwen2.5:1.5b"
TAILOR_MODEL = "qwen2.5:3b"

def _warmup_models() -> None:
    """Pre-loads models into memory so first real request skips the ~60s disk load.
    Retries while Ollama boots; runs entirely in background."""
    import threading
    import time as _time

    def load_model(agent, model: str, ctx: int) -> bool:
        for attempt in range(24):  # up to ~2 minutes
            try:
                agent.client.generate(
                    model=model, prompt="ok", keep_alive="30m",
                    options={"num_predict": 1, "num_ctx": ctx, "num_thread": 4})
                print(f"[Warmup] {model} loaded.", flush=True)
                return True
            except Exception as e:
                if attempt % 4 == 3:
                    print(f"[Warmup] {model} waiting (attempt {attempt + 1}): {e}", flush=True)
                _time.sleep(5)
        return False

    def warm():
        _time.sleep(2)
        load_model(summarizer_agent, QA_MODEL, 2048)
        load_model(tailor_agent, TAILOR_MODEL, 4096)

    threading.Thread(target=warm, daemon=True).start()

ingestor = ProfileIngestor()


def load_profile_fields() -> dict:
    if PROFILE_FIELDS_PATH.exists():
        try:
            return json.loads(PROFILE_FIELDS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_profile_fields(fields: dict) -> None:
    PROFILE_FIELDS_PATH.write_text(json.dumps(fields, indent=2), encoding="utf-8")

def ensure_ollama_running():
    """Checks if Ollama service is listening on 11434; if not, starts it automatically."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    result = sock.connect_ex(('127.0.0.1', 11434))
    sock.close()
    if result != 0:
        print("[Ollama Manager] Ollama server not detected. Auto-launching 'ollama serve'...")
        try:
            subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print("[Ollama Manager] Launched 'ollama serve' process in background.")
        except Exception as e:
            print(f"[Ollama Manager] Could not auto-launch ollama: {e}")

class JobPayload(BaseModel):
    title: str
    company: str
    location: Optional[str] = "N/A"
    url: str
    markdown_content: str

class AskPayload(BaseModel):
    prompt: str
    model: Optional[str] = "qwen2.5:1.5b"

class SummarizePayload(BaseModel):
    job_id: Optional[str] = None
    model: Optional[str] = "qwen2.5:1.5b"

@app.get("/")
def root():
    ensure_ollama_running()
    return {
        "status": "online",
        "mode": "persistent",
        "total_jobs": collection.count(),
        "profile_entries": profile_collection.count(),
    }

app.mount("/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

@app.post("/add-job")
def add_job(job: JobPayload):
    try:
        clean_url = job.url.split('?')[0] if '?' in job.url else job.url
        job_id = hashlib.md5(clean_url.encode('utf-8')).hexdigest()

        existing = collection.get(ids=[job_id])
        is_update = len(existing["ids"]) > 0

        metadata = {
            "title": job.title,
            "company": job.company,
            "location": job.location or "N/A",
            "url": job.url
        }
        
        collection.upsert(
            ids=[job_id],
            documents=[job.markdown_content],
            metadatas=[metadata]
        )
        
        return {
            "success": True,
            "id": job_id,
            "is_update": is_update,
            "message": "Job description updated in ChromaDB" if is_update else "Job description indexed into ChromaDB",
            "total_indexed": collection.count()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/jobs")
def get_jobs():
    results = collection.get()
    return {
        "count": len(results["ids"]),
        "ids": results["ids"],
        "metadatas": results["metadatas"],
        "documents": results["documents"]
    }

class QueryPayload(BaseModel):
    query_texts: list[str]
    n_results: Optional[int] = 3

@app.post("/query")
def query_jobs(payload: QueryPayload):
    try:
        results = collection.query(
            query_texts=payload.query_texts,
            n_results=payload.n_results
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

summarizer_agent = SummarizerAgent(host=OLLAMA_URL)
qa_agent = ApplicationQAAgent(host=OLLAMA_URL)
tailor_agent = ResumeTailorAgent(host=OLLAMA_URL)
_warmup_models()

def find_master_tex(explicit_text: Optional[str] = None) -> tuple[str, str]:
    """Returns (name, latex_source). Prefers explicit text, else newest .tex upload."""
    if explicit_text and "\\begin{document}" in explicit_text:
        return "pasted.tex", explicit_text
    tex_files = [f for f in UPLOADS_DIR.glob("*.tex") if f.is_file()]
    if not tex_files:
        raise HTTPException(status_code=404,
                            detail="No master .tex resume found. Upload one on the Profile Setup page.")
    latest = max(tex_files, key=lambda f: f.stat().st_mtime)
    return latest.name, latest.read_text(encoding="utf-8-sig", errors="replace")

def strip_latex_to_text(tex: str) -> str:
    text = re.sub(r"(?m)(?<!\\)%.*$", "", tex)
    body = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", text, re.DOTALL)
    text = body.group(1) if body else text
    for _ in range(3):
        text = re.sub(r"\\(?:textbf|textit|emph|underline|texttt)\s*\{([^{}]*)\}", r"\1", text)
    text = re.sub(r"\\(?:begin|end)\s*\{[^}]*\}", "\n", text)
    text = re.sub(r"\n\s*\\item", "\n- ", text)
    text = re.sub(r"\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^{}]*\})?", " ", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()

def compile_pdf(tex_source: str, out_stem: str) -> Optional[str]:
    """Compiles LaTeX via MiKTeX pdflatex if available. Returns pdf filename or None."""
    if not shutil.which("pdflatex"):
        return None
    safe_stem = re.sub(r"[^A-Za-z0-9_\-]", "_", out_stem)[:80] or "tailored_resume"
    try:
        tex_source = re.sub(r"^(?:\ufeff|\xef\xbb\xbf|\s)+", "", tex_source)
        with tempfile.TemporaryDirectory() as tmp:
            tex_path = Path(tmp) / "resume.tex"
            tex_path.write_text(tex_source, encoding="utf-8")
            result = subprocess.run(
                ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "resume.tex"],
                cwd=tmp, capture_output=True, timeout=120,
            )
            pdf_path = Path(tmp) / "resume.pdf"
            if result.returncode == 0 and pdf_path.exists():
                dest = OUTPUT_DIR / f"{safe_stem}.pdf"
                shutil.copyfile(pdf_path, dest)
                return dest.name
    except Exception as e:
        print(f"[Tailor] Compile failed: {e}")
    return None

class TailorPayload(BaseModel):
    job_id: Optional[str] = None
    model: Optional[str] = "qwen2.5:3b"
    master_tex_text: Optional[str] = None

@app.post("/tailor/resume")
def tailor_resume(payload: TailorPayload):
    """Streams tailored LaTeX (NDJSON thinking/content lines), saves .tex and compiled PDF."""
    ensure_ollama_running()
    if collection.count() == 0:
        raise HTTPException(status_code=400,
                            detail="No indexed job descriptions. Index a job page first.")
    if profile_collection.count() == 0:
        raise HTTPException(status_code=400,
                            detail="Profile is empty. Complete Profile Setup first.")

    if payload.job_id:
        res = collection.get(ids=[payload.job_id], include=["documents", "metadatas"])
        if not res["documents"]:
            raise HTTPException(status_code=404, detail="Job ID not found.")
        doc, meta = res["documents"][0], res["metadatas"][0]
    else:
        res = collection.get(include=["documents", "metadatas"])
        doc, meta = res["documents"][-1], res["metadatas"][-1]

    job_context = f"{meta.get('title', 'Unknown')} at {meta.get('company', 'Unknown')}"
    master_name, master_tex = find_master_tex(payload.master_tex_text)

    search = profile_collection.query(query_texts=[doc[:2000]], n_results=6)
    profile_chunks = search["documents"][0] if search["documents"] else []
    profile_context = "\n---\n".join(profile_chunks)

    def event_generator():
        content_buffer = []
        try:
            for line in tailor_agent.generate_tailored(
                master_tex=master_tex,
                job_doc=doc,
                job_context=job_context,
                profile_context=profile_context,
                model=payload.model,
            ):
                try:
                    parsed = json.loads(line)
                    if parsed.get("type") == "content":
                        content_buffer.append(parsed.get("text", ""))
                except Exception:
                    pass
                yield line
        except Exception as e:
            yield json.dumps({"type": "error", "text": str(e)}) + "\n"

        full_output = "".join(content_buffer)
        cleaned = full_output.strip()
        fence = re.match(r"^```(?:latex)?\s*\n(.*?)\n?```\s*$", cleaned, re.DOTALL)
        if fence:
            cleaned = fence.group(1).strip()
        if not cleaned.startswith("\\documentclass"):
            first_doc = cleaned.find("\\documentclass")
            if first_doc > 0:
                cleaned = cleaned[first_doc:]

        company_slug = re.sub(r"[^A-Za-z0-9]+", "_", meta.get("company", "Company")).strip("_")[:30]
        title_slug = re.sub(r"[^A-Za-z0-9]+", "_", meta.get("title", "Role")).strip("_")[:30]
        stamp = Path(master_name).stem[:20]
        out_stem = f"{title_slug}_{company_slug}_{stamp}"

        tex_name = None
        pdf_name = None
        if "\\begin{document}" in cleaned:
            tex_path = OUTPUT_DIR / f"{out_stem}.tex"
            tex_path.write_text(cleaned, encoding="utf-8")
            tex_name = tex_path.name
            pdf_name = compile_pdf(cleaned, out_stem)
        else:
            yield json.dumps({"type": "warning",
                              "text": "Output missing \\begin{document} - not saved as valid resume."}) + "\n"

        done = {"type": "saved", "filename": tex_name, "pdf_filename": pdf_name}
        yield json.dumps(done) + "\n"

    return StreamingResponse(event_generator(), media_type="text/plain")

class QuestionPayload(BaseModel):
    question: str
    job_id: Optional[str] = None
    model: Optional[str] = "qwen2.5:1.5b"
    max_results: Optional[int] = 4

@app.post("/answer/question")
def answer_application_question(payload: QuestionPayload):
    """RAG answer to an employer application question, grounded in the user's profile."""
    ensure_ollama_running()
    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Empty question.")
    if profile_collection.count() == 0:
        raise HTTPException(status_code=400,
                            detail="Profile is empty. Complete onboarding first (extension Options page).")

    search = profile_collection.query(
        query_texts=[payload.question],
        n_results=min(payload.max_results or 4, 8),
    )
    docs = search["documents"][0] if search["documents"] else []
    metas = search["metadatas"][0] if search["metadatas"] else []

    context_parts = [
        f"[{m.get('entry_type', 'general')}: {m.get('title', '')}]\n{d[:1200]}"
        for m, d in zip(metas, docs)
    ]

    job_context = "Unknown position"
    if payload.job_id:
        res = collection.get(ids=[payload.job_id], include=["documents", "metadatas"])
        if res["documents"]:
            meta = res["metadatas"][0]
            job_context = f"{meta.get('title', 'Unknown')} at {meta.get('company', 'Unknown')}"
            context_parts.append(f"[Job Description]\n{res['documents'][0][:1500]}")

    context = "\n---\n".join(context_parts)

    try:
        answer = qa_agent.answer(
            question=payload.question,
            context=context,
            job_context=job_context,
            model=payload.model,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama error: {e}")

    return {"answer": answer, "needs_review": answer.upper().startswith("NEEDS_REVIEW")}

class OverleafStatusPayload(BaseModel):
    cookie: str

@app.post("/overleaf/status")
def overleaf_status(payload: OverleafStatusPayload):
    """Verifies the session cookie and lists projects. Cookie kept in memory only."""
    try:
        client = OverleafClient(payload.cookie)
        projects, debug = client.verify_session()
        return {"ok": True, "projects": projects, "debug": debug}
    except OverleafError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Overleaf unreachable: {e}")

class OverleafPushPayload(BaseModel):
    cookie: str
    tex_text: str
    project_name: str = "Tailored Resume"
    filename: str = "main.tex"
    fetch_pdf: bool = True
    target_project_id: Optional[str] = None

@app.post("/overleaf/push")
def overleaf_push(payload: OverleafPushPayload):
    """Pushes tailored resume to Overleaf. If target_project_id is given, updates that
    project's file in place; otherwise creates a new project."""
    if "\\begin{document}" not in payload.tex_text:
        raise HTTPException(status_code=400, detail="tex_text is not a complete LaTeX document.")
    try:
        client = OverleafClient(payload.cookie)

        target_id = payload.target_project_id
        if target_id:
            m = re.search(r"([a-f0-9]{24})", target_id, re.IGNORECASE)
            if not m:
                raise HTTPException(status_code=400,
                                    detail=f"Invalid Overleaf project reference: {target_id}")
            target_id = m.group(1)

        if target_id:
            result = client.push_to_existing_project(
                target_id, payload.tex_text, payload.filename,
                wait_seconds=120 if payload.fetch_pdf else 0,
            )
            response = {
                "ok": True,
                "mode": result["mode"],
                "project_id": target_id,
                "url": f"{client.BASE}/project/{target_id}",
                "doc_name": result.get("doc_name"),
            }
            if payload.fetch_pdf and result.get("pdf_b64"):
                import base64 as _b64
                pdf_bytes = _b64.b64decode(result["pdf_b64"])
                safe_name = re.sub(r"[^A-Za-z0-9_\-]", "_",
                                   f"overleaf_{target_id[:8]}") + ".pdf"
                (OUTPUT_DIR / safe_name).write_bytes(pdf_bytes)
                response["pdf_filename"] = safe_name
                response["message"] = f"Updated {result['doc_name']} in your project and downloaded compiled PDF."
            else:
                response["message"] = f"Updated {result.get('doc_name', 'main.tex')} in your project."
            return response

        created = client.create_project_with_tex(payload.project_name, payload.filename,
                                                 payload.tex_text)
        response = build_push_response(client, created["project_id"], payload.fetch_pdf)
        response["mode"] = "created"
        return response
    except HTTPException:
        raise
    except OverleafError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Overleaf push failed: {e}")

class SavePdfPayload(BaseModel):
    filename: str = "overleaf_resume.pdf"
    content_b64: str

@app.post("/overleaf/save-pdf")
def overleaf_save_pdf(payload: SavePdfPayload):
    """Stores a PDF fetched by the extension (compiled on Overleaf) into the output dir."""
    try:
        safe = re.sub(r"[^A-Za-z0-9_\-]", "_", payload.filename)[:80] or "overleaf_resume"
        if not safe.lower().endswith(".pdf"):
            safe += ".pdf"
        data = base64.b64decode(payload.content_b64)
        if not data.startswith(b"%PDF"):
            raise HTTPException(status_code=400, detail="Content is not a valid PDF.")
        (OUTPUT_DIR / safe).write_bytes(data)
        return {"ok": True, "filename": safe}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/resume/latest")
def get_latest_resume():
    """Returns the most recently produced resume file (tailored PDF preferred)."""
    candidates = []
    for directory in (OUTPUT_DIR, UPLOADS_DIR):
        for f in directory.iterdir():
            if f.is_file():
                candidates.append(f)
    if not candidates:
        raise HTTPException(status_code=404,
                            detail="No resume files found. Upload a resume via the extension options page or tailor one first.")
    def rank(path: Path):
        is_pdf = path.suffix.lower() == ".pdf"
        from_output = path.parent == OUTPUT_DIR
        return (is_pdf and from_output, is_pdf, path.stat().st_mtime)
    latest = max(candidates, key=rank)
    data = base64.b64encode(latest.read_bytes()).decode("ascii")
    return {
        "filename": latest.name,
        "content_b64": data,
        "modified": latest.stat().st_mtime,
        "is_tailored": latest.parent == OUTPUT_DIR,
    }

@app.post("/summarize")
def summarize_job(payload: SummarizePayload):
    ensure_ollama_running()
    if payload.job_id:
        res = collection.get(ids=[payload.job_id])
        if not res["documents"]:
            raise HTTPException(status_code=404, detail="Job ID not found in ChromaDB.")
        doc = res["documents"][0]
        meta = res["metadatas"][0]
    else:
        res = collection.get()
        if not res["documents"]:
            raise HTTPException(status_code=400, detail="No job descriptions currently indexed in ChromaDB. Click 'Index Active Page' first!")
        doc = res["documents"][-1]
        meta = res["metadatas"][-1]

    truncated_doc = doc[:4000] if len(doc) > 4000 else doc

    def event_generator():
        try:
            for token in summarizer_agent.generate_summary(
                title=meta.get('title', 'Unknown'),
                company=meta.get('company', 'Unknown'),
                document=truncated_doc,
                model=payload.model
            ):
                yield token
        except Exception as e:
            yield f"\n[Streaming Error: {str(e)}]"

    return StreamingResponse(event_generator(), media_type="text/plain")

@app.post("/ask")
def ask_jobs(payload: AskPayload):
    ensure_ollama_running()
    search = collection.query(query_texts=[payload.prompt], n_results=3)
    docs = search["documents"][0] if search["documents"] else []
    metas = search["metadatas"][0] if search["metadatas"] else []

    if not docs:
        raise HTTPException(status_code=400, detail="No indexed jobs found in ChromaDB to answer from. Please click 'Index Active Page' first!")

    context = "\n---\n".join([f"Job: {m.get('title')} at {m.get('company')}\nContent:\n{d[:2000]}" for m, d in zip(metas, docs)])

    def event_generator():
        try:
            for token in summarizer_agent.answer_query(
                context=context,
                question=payload.prompt,
                model=payload.model
            ):
                yield token
        except Exception as e:
            yield f"\n[Streaming Error: {str(e)}]"

    return StreamingResponse(event_generator(), media_type="text/plain")

class FilePayload(BaseModel):
    filename: str
    content_b64: Optional[str] = None
    content_text: Optional[str] = None

class ProfileEntryPayload(BaseModel):
    type: str = "general"
    title: str
    content: str

class ProfileImportPayload(BaseModel):
    structured: Optional[dict] = {}
    entries: list[ProfileEntryPayload] = []
    files: list[FilePayload] = []

@app.post("/profile/import")
def profile_import(payload: ProfileImportPayload):
    """Ingests onboarding data: structured fields, manual entries, and resume files."""
    try:
        added, skipped = 0, 0
        fields = load_profile_fields()

        if payload.structured:
            for k, v in payload.structured.items():
                v = (v or "").strip()
                if v:
                    fields[k] = v

        docs_to_upsert = {"ids": [], "documents": [], "metadatas": []}

        for f in payload.files:
            try:
                text = ingestor.parse_file(f.filename, f.content_b64, f.content_text)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Failed to parse {f.filename}: {e}")

            safe_name = Path(f.filename).name
            dest = UPLOADS_DIR / safe_name
            if f.content_text is not None:
                dest.write_text(f.content_text, encoding="utf-8")
            elif f.content_b64:
                dest.write_bytes(base64.b64decode(f.content_b64))

            entries = ingestor.build_entries(safe_name, text)
            auto_fields = extract_structured_fields(text[:3000])
            for k, v in auto_fields.items():
                fields.setdefault(k, v)
            for e in entries:
                docs_to_upsert["ids"].append(e["id"])
                docs_to_upsert["documents"].append(e["document"])
                docs_to_upsert["metadatas"].append(e["metadata"])

        structured_doc = ingestor.structured_doc(fields)
        if structured_doc:
            docs_to_upsert["ids"].append(structured_doc["id"])
            docs_to_upsert["documents"].append(structured_doc["document"])
            docs_to_upsert["metadatas"].append(structured_doc["metadata"])

        for entry in payload.entries:
            content = entry.content.strip()
            if not content or not entry.title.strip():
                skipped += 1
                continue
            e = ingestor._make_entry(entry.type, entry.title.strip(), content,
                                     "onboarding-form")
            docs_to_upsert["ids"].append(e["id"])
            docs_to_upsert["documents"].append(e["document"])
            docs_to_upsert["metadatas"].append(e["metadata"])

        if docs_to_upsert["ids"]:
            existing = set(profile_collection.get(ids=docs_to_upsert["ids"])["ids"])
            added = sum(1 for i in docs_to_upsert["ids"] if i not in existing)
            profile_collection.upsert(
                ids=docs_to_upsert["ids"],
                documents=docs_to_upsert["documents"],
                metadatas=docs_to_upsert["metadatas"],
            )
        save_profile_fields(fields)

        return {
            "success": True,
            "entries_added": added,
            "skipped": skipped,
            "total_profile_entries": profile_collection.count(),
            "structured_fields": sorted(fields.keys()),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/profile")
def get_profile():
    res = profile_collection.get(include=["documents", "metadatas"])
    return {
        "fields": load_profile_fields(),
        "count": len(res["ids"]),
        "entries": [
            {"id": i, "content": d, **m}
            for i, d, m in zip(res["ids"], res["documents"], res["metadatas"])
        ],
    }

@app.get("/profile/fields")
def get_profile_fields():
    return load_profile_fields()

@app.delete("/profile/entry/{entry_id}")
def delete_profile_entry(entry_id: str):
    try:
        profile_collection.delete(ids=[entry_id])
        return {"success": True, "total_profile_entries": profile_collection.count()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/profile/query")
def query_profile(payload: QueryPayload):
    try:
        results = profile_collection.query(
            query_texts=payload.query_texts,
            n_results=payload.n_results,
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
