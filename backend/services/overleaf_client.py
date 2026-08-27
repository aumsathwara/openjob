import io
import json
import re
import time
import zipfile
import base64
import html as html_lib
from typing import Optional

import requests

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Meta tags live in served HTML; attribute order varies so match loosely.
META_TAG_RE_TEMPLATE = r"<meta[^>]+name=[\"']{0}[\"'][^>]*>"
ATTR_RE_TEMPLATE = r"{attr}=[\"']([^\"']*)[\"']"
PROJECT_ID_RE = re.compile(r"/project/([a-f0-9]{24})", re.IGNORECASE)


class OverleafError(Exception):
    pass


def _extract_meta(page_html: str, meta_name: str) -> Optional[str]:
    tag_match = re.search(META_TAG_RE_TEMPLATE.format(meta_name), page_html, re.IGNORECASE)
    if not tag_match:
        return None
    tag = tag_match.group(0)
    content_match = re.search(ATTR_RE_TEMPLATE.format(attr="content"), tag, re.IGNORECASE)
    return content_match.group(1) if content_match else None


class OverleafClient:
    """Minimal client for Overleaf's web app, authenticated with the browser's
    overleaf_session2 cookie. The cookie is held in memory only."""

    BASE = "https://www.overleaf.com"

    def __init__(self, session_cookie: str):
        if not session_cookie:
            raise OverleafError("No Overleaf session cookie provided.")
        self.session_cookie = session_cookie
        self.http = requests.Session()
        self.http.cookies.set("overleaf_session2", session_cookie,
                              domain=".overleaf.com")
        self.http.headers.update({
            "User-Agent": USER_AGENT,
            "Referer": f"{self.BASE}/project",
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        })
        self._csrf: Optional[str] = None

    def _ws_handshake_headers(self) -> dict:
        """WebSocket upgrades don't inherit the requests session cookie jar,
        so the session cookie must be passed explicitly."""
        return {
            "Cookie": f"overleaf_session2={self.session_cookie}",
            "Origin": self.BASE,
            "User-Agent": USER_AGENT,
        }

    # ---------- Session & CSRF ----------

    def _fetch_csrf(self) -> str:
        """Overleaf serves its CSRF token as an ol-csrfToken meta tag on every page."""
        if self._csrf:
            return self._csrf
        last_exc: Optional[Exception] = None
        for path in ("/project", "/login"):
            try:
                r = self.http.get(f"{self.BASE}{path}", timeout=30, allow_redirects=True)
                token = _extract_meta(r.text, "ol-csrfToken")
                if token:
                    self._csrf = token
                    return token
            except Exception as e:
                last_exc = e
        if last_exc:
            raise OverleafError(f"Overleaf unreachable: {last_exc}")
        raise OverleafError("Could not find CSRF token on Overleaf pages.")

    def check_logged_in(self) -> bool:
        """True if /project does NOT redirect to /login."""
        r = self.http.get(f"{self.BASE}/project", allow_redirects=False, timeout=30)
        if r.status_code in (301, 302, 303, 307, 308):
            location = r.headers.get("Location", "")
            if "/login" in location:
                return False
            # Follow one manual redirect hop and re-check
            r2 = self.http.get(f"{self.BASE}{location}", allow_redirects=False, timeout=30)
            if r2.status_code in (301, 302, 303, 307, 308):
                return "/login" not in r2.headers.get("Location", "")
            return True
        return r.status_code == 200

    def verify_session(self) -> tuple[list[dict], dict]:
        if not self.check_logged_in():
            raise OverleafError(
                "Session invalid or expired. Log into overleaf.com in this "
                "browser, then click Check again."
            )
        debug: dict = {"strategy": None, "meta_names": [], "html_len": 0}

        # Strategy 1: dedicated JSON endpoint (used by some dashboard builds)
        projects = self._fetch_projects_json()
        if projects is not None:
            debug["strategy"] = "user/projects JSON"
            return projects, debug

        # Strategy 2: prefetched blob embedded in dashboard HTML
        r = self.http.get(f"{self.BASE}/project", timeout=60, allow_redirects=True)
        if r.status_code != 200:
            raise OverleafError(f"Unexpected dashboard response (HTTP {r.status_code}).")
        page_html = r.text
        token = _extract_meta(page_html, "ol-csrfToken")
        if token:
            self._csrf = token
        debug["html_len"] = len(page_html)
        debug["meta_names"] = re.findall(
            r"<meta[^>]+name=[\"'](ol-[^\"']+)[\"']", page_html, re.IGNORECASE
        )[:40]

        projects = self._parse_projects_from_dashboard(page_html)
        if projects:
            debug["strategy"] = "dashboard HTML blob"
            return projects, debug

        debug["strategy"] = "none - page had no project data"
        return [], debug

    def _fetch_projects_json(self) -> Optional[list[dict]]:
        try:
            r = self.http.get(f"{self.BASE}/user/projects",
                              headers={"Accept": "application/json",
                                       "X-Requested-With": "XMLHttpRequest"},
                              timeout=30)
        except Exception:
            return None
        if r.status_code != 200:
            return None
        try:
            data = r.json()
        except Exception:
            return None
        raw = data.get("projects", []) if isinstance(data, dict) else data
        if isinstance(raw, dict):
            raw = list(raw.values())
        projects = []
        for p in raw:
            if isinstance(p, dict) and p.get("_id"):
                projects.append({
                    "id": p["_id"],
                    "name": p.get("name") or "Untitled",
                    "last_updated": p.get("lastUpdated"),
                })
        return projects if projects else None

    @staticmethod
    def _parse_projects_from_dashboard(page_html: str) -> tuple[list[dict], dict]:
        """Returns (projects, debug_info). Handles dashboard blob, legacy meta,
        editor-page single project, and href scraping."""
        debug = {"html_len": len(page_html),
                 "meta_names": re.findall(r'<meta[^>]+name="(ol-[^"]+)"', page_html)[:40],
                 "source": None}
        projects: list[dict] = []

        def add(pid: str, name: Optional[str]):
            if pid and not any(p["id"] == pid for p in projects):
                projects.append({"id": pid, "name": name or "(untitled)",
                                 "last_updated": None})

        # 1. Modern dashboard: ol-prefetchedProjectsBlob (HTML-escaped JSON)
        blob = _extract_meta(page_html, "ol-prefetchedProjectsBlob")
        if blob:
            try:
                data = json.loads(html_lib.unescape(blob))
                raw = data.get("projects", []) if isinstance(data, dict) else data
                if isinstance(raw, dict):
                    raw = list(raw.values())
                for p in raw:
                    if isinstance(p, dict) and p.get("_id"):
                        add(p["_id"], p.get("name"))
                if projects:
                    debug["source"] = "ol-prefetchedProjectsBlob"
                    return projects, debug
            except Exception:
                pass

        # 2. Legacy dashboard: ol-projects
        legacy = _extract_meta(page_html, "ol-projects")
        if legacy:
            try:
                data = json.loads(html_lib.unescape(legacy))
                if isinstance(data, list):
                    for p in data:
                        if p.get("id") or p.get("_id"):
                            add(p.get("id") or p.get("_id"), p.get("name"))
                if projects:
                    debug["source"] = "ol-projects"
                    return projects, debug
            except Exception:
                pass

        # 3. Editor page: current project exposed directly via meta tags
        current_id = _extract_meta(page_html, "ol-project_id")
        if current_id:
            add(current_id, _extract_meta(page_html, "ol-project_name"))
            debug["source"] = "ol-project_id"

        # 4. Last resort: scrape project links out of the HTML
        for m in re.finditer(r'href="/project/([a-f0-9]{24})"', page_html, re.IGNORECASE):
            add(m.group(1), None)
        if projects and not debug["source"]:
            debug["source"] = "href-scan"

        return projects, debug

    # ---------- Authenticated calls ----------

    def _authed_get(self, path: str, **kwargs) -> requests.Response:
        headers = kwargs.pop("headers", {})
        headers["X-CSRF-Token"] = self._fetch_csrf()
        return self.http.get(f"{self.BASE}{path}", headers=headers,
                             timeout=kwargs.pop("timeout", 90), **kwargs)

    def _authed_post(self, path: str, **kwargs) -> requests.Response:
        headers = kwargs.pop("headers", {})
        headers["X-CSRF-Token"] = self._fetch_csrf()
        return self.http.post(f"{self.BASE}{path}", headers=headers,
                              timeout=kwargs.pop("timeout", 180), **kwargs)

    # ---------- Project tree & in-place updates ----------

    def get_project_tree(self, project_id: str) -> dict:
        """Fetches the project file tree via socket.io joinProject.
        Returns {"root_folder": {...}, "docs": [{"id","name","path"}]}."""
        try:
            import socketio
        except ImportError:
            raise OverleafError("python-socketio not installed. Run: pip install 'python-socketio[client]'")

        self._fetch_csrf()

        ws_headers = self._ws_handshake_headers()
        last_error: Optional[Exception] = None
        sio = None
        for transports in (["websocket"], ["polling"]):
            sio = socketio.Client(logger=False, engineio_logger=False,
                                  reconnection=False, request_timeout=30,
                                  http_session=self.http)
            try:
                sio.connect(self.BASE, transports=transports,
                            socketio_path="socket.io", headers=ws_headers)
                break
            except Exception as e:
                last_error = e
                try:
                    sio.disconnect()
                except Exception:
                    pass
                sio = None
                continue
        if not sio or not sio.connected:
            raise OverleafError(
                f"Could not connect to Overleaf's realtime service ({last_error}). "
                "Your session may have expired - log into overleaf.com again and retry."
            )

        sio = sio  # connected client
        try:
            result = sio.call("joinProject", {"project_id": project_id}, timeout=30)
            if isinstance(result, list):
                result = result[0] if result else {}
            if not isinstance(result, dict) or not result.get("project"):
                raise OverleafError(
                    f"Could not load project tree (unexpected joinProject reply). "
                    f"Raw type: {type(result).__name__}. Check the project ID."
                )
            project = result["project"]
            root_folders = project.get("rootFolder", [])

            docs = []
            def walk(folder, prefix):
                for d in folder.get("docs", []):
                    docs.append({"id": d.get("_id"), "name": d.get("name"),
                                 "path": f"{prefix}{d.get('name')}"})
                for sub in folder.get("folders", []):
                    walk(sub, f"{prefix}{sub.get('name')}/")

            for rf in root_folders:
                walk(rf, "")
            return {"root_folder": root_folders[0] if root_folders else {},
                    "root_folder_id": root_folders[0].get("_id") if root_folders else None,
                    "docs": docs}
        except OverleafError:
            raise
        except Exception as e:
            raise OverleafError(f"Project tree fetch failed: {e}")
        finally:
            try:
                sio.disconnect()
            except Exception:
                pass

    @staticmethod
    def pick_doc(tree: dict, filename: str) -> Optional[dict]:
        """Finds a doc by name (case-insensitive), preferring root level."""
        wanted = filename.lower()
        exact = [d for d in tree["docs"] if d["name"].lower() == wanted]
        stem = [d for d in tree["docs"]
                if d["name"].lower().rsplit(".", 1)[0] == wanted.rsplit(".", 1)[0]]
        if exact:
            exact.sort(key=lambda d: (d["path"].count("/"), d["path"]))
            return exact[0]
        if stem:
            stem.sort(key=lambda d: (d["path"].count("/"), d["path"]))
            return stem[0]
        return None

    def update_doc(self, project_id: str, doc_id: str, content: str) -> None:
        r = self._authed_post(f"/project/{project_id}/doc/{doc_id}",
                              json={"newDoc": content},
                              headers={"Accept": "application/json"})
        if r.status_code in (200, 201, 204):
            return
        # Fallback: some versions accept raw text body instead of JSON
        r2 = self._authed_post(f"/project/{project_id}/doc/{doc_id}",
                               data=content.encode("utf-8"),
                               headers={"Content-Type": "text/plain",
                                        "Accept": "application/json"})
        if r2.status_code in (200, 201, 204):
            return
        raise OverleafError(
            f"Doc update failed (HTTP {r.status_code}, fallback {r2.status_code}). "
            "The file may be open in another editor window - close it and retry."
        )

    def push_to_existing_project(self, project_id: str, tex_text: str,
                                 filename: str = "main.tex",
                                 wait_seconds: int = 120) -> dict:
        """Updates filename in-place inside project_id, then compiles."""
        tree = self.get_project_tree(project_id)
        doc = self.pick_doc(tree, filename)
        if not doc:
            listing = ", ".join(d["path"] for d in tree["docs"][:15]) or "(no docs found)"
            raise OverleafError(
                f"'{filename}' not found in project. Docs present: {listing}"
            )
        self.update_doc(project_id, doc["id"], tex_text)
        pdf_bytes: Optional[bytes] = None
        try:
            pdf_bytes = self.compile_and_fetch_pdf(project_id, wait_seconds)
        except OverleafError:
            pass  # compile issues shouldn't mask a successful push
        return {
            "mode": "updated",
            "doc_name": doc["path"],
            "pdf_b64": base64.b64encode(pdf_bytes).decode("ascii") if pdf_bytes else None,
        }

    def create_project_with_tex(self, project_name: str, filename: str,
                                tex_text: str) -> dict:
        """Creates a new Overleaf project from a zip containing the resume .tex."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(filename or "main.tex", tex_text)
        zip_bytes = buf.getvalue()

        r = self._authed_post(
            "/project/new/upload",
            data={"_csrf": self._fetch_csrf(), "qp_name": project_name},
            files={"qqfile": (f"{project_name}.zip", zip_bytes, "application/zip")},
        )
        if r.status_code != 200:
            raise OverleafError(
                f"Project upload failed (HTTP {r.status_code}). "
                "If this persists, Overleaf's upload flow may have changed."
            )

        data = {}
        try:
            data = r.json()
        except Exception:
            pass

        project_id = None
        if data.get("success"):
            project_id = data.get("project_id") or data.get("projectId")
            if not project_id and data.get("redir"):
                m = PROJECT_ID_RE.search(data["redir"])
                project_id = m.group(1) if m else None
        if not project_id:
            m = PROJECT_ID_RE.search(str(r.url))
            if m:
                project_id = m.group(1)
        if not project_id:
            snippet = r.text[:200].replace("\n", " ")
            raise OverleafError(f"Could not confirm created project. Response: {snippet}")

        return {"project_id": project_id, "name": project_name}

    def compile_and_fetch_pdf(self, project_id: str, wait_seconds: int = 120) -> bytes:
        """Triggers a compile, prefers the returned pdfDownloadUrl, then polls."""
        pdf_url: Optional[str] = None
        try:
            r = self._authed_post(
                f"/project/{project_id}/compile",
                json={"draft": False, "stopOnFirstError": True},
                headers={"Accept": "application/json"},
            )
            try:
                data = r.json()
                pdf_url = data.get("pdfDownloadUrl")
            except Exception:
                pass
        except Exception:
            pass

        candidates = []
        if pdf_url:
            candidates.append(pdf_url if pdf_url.startswith("http")
                              else f"{self.BASE}{pdf_url}")
        candidates.append(
            f"{self.BASE}/download/project/{project_id}/build/latest/output/output.pdf")

        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            for url in candidates:
                try:
                    r = self.http.get(url, timeout=60)
                    if (r.status_code == 200 and
                            r.headers.get("content-type", "").startswith("application/pdf")):
                        return r.content
                except Exception:
                    continue
            time.sleep(5)

        raise OverleafError(
            "Compiled PDF was not ready in time. Open the project in Overleaf "
            "and download the PDF manually."
        )


def build_push_response(client: OverleafClient, project_id: str, want_pdf: bool) -> dict:
    result = {"ok": True, "project_id": project_id,
              "url": f"{client.BASE}/project/{project_id}"}
    if want_pdf:
        try:
            pdf = client.compile_and_fetch_pdf(project_id)
            result["pdf_b64"] = base64.b64encode(pdf).decode("ascii")
            result["message"] = "Pushed to Overleaf and compiled PDF downloaded."
        except OverleafError as e:
            result["message"] = f"Pushed to Overleaf, but PDF fetch failed: {e}"
    else:
        result["message"] = "Pushed to Overleaf."
    return result
