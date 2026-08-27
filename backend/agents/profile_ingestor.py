import io
import re
import uuid
from typing import Optional

PROFILE_NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")

SECTION_TYPE_MAP = [
    (r"(experience|employment|work\s*history|professional)", "experience"),
    (r"(project|portfolio)", "project"),
    (r"(skill|technolog|technical)", "skill"),
    (r"education", "education"),
    (r"(summary|objective|about|profile)", "summary"),
]

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}")
LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/in/[A-Za-z0-9_\-]+/?", re.IGNORECASE)
GITHUB_RE = re.compile(r"(?:https?://)?(?:www\.)?github\.com/[A-Za-z0-9_\-]+/?", re.IGNORECASE)
URL_RE = re.compile(r"https?://[^\s)>\]}]+")

LATEX_CMD_RE = re.compile(r"\\(?:textbf|textit|emph|underline|texttt|mbox|text|hline)\s*\{([^{}]*)\}")
LATEX_ITEM_RE = re.compile(r"\\item\s*")
LATEX_SECTION_RE = re.compile(
    r"\\(?:section|subsection)\s*\*?\s*\{(?P<title>[^}]*)\}", re.IGNORECASE
)
LATEX_NAME_RE = re.compile(r"\\(?:name|author)\s*\{(?P<name>[^}]*)\}")


def stable_id(*parts: str) -> str:
    return str(uuid.uuid5(PROFILE_NAMESPACE, ":".join(parts)))


def extract_pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(pages)


def clean_latex_body(text: str) -> str:
    prev = None
    while prev != text:
        prev = text
        text = LATEX_CMD_RE.sub(r"\1", text)
    text = re.sub(r"\\(?:begin|end)\s*\{[^}]*\}", "", text)
    text = LATEX_ITEM_RE.sub("\n- ", text)
    replacements = {
        "&": " ",
        "\\\\": "\n",
        "~": " ",
        "$": "",
        "%": "",
        "#": "",
        "_": " ",
        "{": "",
        "}": "",
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    text = re.sub(r"\\[a-zA-Z]+\*?(\[[^\]]*\])?", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_comments(text: str) -> str:
    return re.sub(r"(?m)(?<!\\)%.*$", "", text)


def latex_body(text: str) -> str:
    match = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", text, re.DOTALL)
    return match.group(1) if match else text


def classify_section(title: str) -> str:
    lowered = title.lower()
    for pattern, entry_type in SECTION_TYPE_MAP:
        if re.search(pattern, lowered):
            return entry_type
    return "general"


def extract_structured_fields(text: str) -> dict:
    fields = {}
    email = EMAIL_RE.search(text)
    if email:
        fields["email"] = email.group(0).lower()
    phone = PHONE_RE.search(text)
    if phone:
        fields["phone"] = phone.group(0).strip()
    linkedin = LINKEDIN_RE.search(text)
    if linkedin:
        fields["linkedin"] = linkedin.group(0).rstrip("/")
    github = GITHUB_RE.search(text)
    if github:
        fields["github"] = github.group(0).rstrip("/")
    urls = [u.rstrip("/.,;") for u in URL_RE.findall(text)]
    extras = [
        u for u in urls
        if "linkedin.com" not in u and "github.com" not in u
        and "overleaf.com" not in u and len(u) < 120
    ]
    if extras:
        fields["website"] = extras[0]
    return fields


class ProfileIngestor:
    """Parses uploaded resume/profile files into chunked, typed ChromaDB entries."""

    MAX_CHUNK_CHARS = 1500

    def parse_file(self, filename: str, content_b64: Optional[str] = None,
                   content_text: Optional[str] = None) -> str:
        lower = filename.lower()
        if content_text is not None:
            return content_text
        if content_b64 is None:
            raise ValueError(f"No content provided for {filename}")
        import base64

        raw = base64.b64decode(content_b64)
        if lower.endswith(".pdf"):
            return extract_pdf_text(raw)
        if lower.endswith((".tex", ".txt", ".md", ".rtf")) or True:
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError:
                return raw.decode("latin-1", errors="replace")

    def build_entries(self, source: str, text: str) -> list[dict]:
        """Returns list of {id, document, metadata} ready for ChromaDB upsert."""
        entries = []
        if source.lower().endswith(".tex") or "\\section{" in text or "\\subsection{" in text:
            entries = self._entries_from_latex(source, text)
        elif re.search(r"^#{1,3}\s+", text, re.MULTILINE):
            entries = self._entries_from_markdown(source, text)
        else:
            entries = self._entries_from_plain_text(source, text)

        seen = set()
        deduped = []
        for e in entries:
            if e["id"] in seen:
                continue
            seen.add(e["id"])
            deduped.append(e)
        return deduped

    def _entries_from_latex(self, source: str, text: str) -> list[dict]:
        text = strip_comments(text)
        body = latex_body(text)
        matches = list(LATEX_SECTION_RE.finditer(body))
        entries = []

        name_match = LATEX_NAME_RE.search(text)
        header_end = matches[0].start() if matches else len(body)
        header = clean_latex_body(body[:header_end])
        if len(header) > 40 or name_match:
            personal_lines = []
            if name_match:
                personal_lines.append(f"Name: {name_match.group('name').strip()}")
            fields = extract_structured_fields(header)
            personal_lines.extend(f"{k.capitalize()}: {v}" for k, v in fields.items())
            if header.strip():
                personal_lines.append(header.strip())
            entries.append(self._make_entry("personal", "Contact & Header Info",
                                            "\n".join(personal_lines), source))

        for i, match in enumerate(matches):
            title = match.group("title").strip()
            start = match.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
            cleaned = clean_latex_body(body[start:end])
            if not cleaned:
                continue
            entry_type = classify_section(title)
            for chunk in self._chunks(cleaned):
                entries.append(self._make_entry(entry_type, title, chunk, source))
        return entries

    def _entries_from_markdown(self, source: str, text: str) -> list[dict]:
        parts = re.split(r"^(#{1,3})\s+(.+)$", text, flags=re.MULTILINE)
        entries = []
        if parts[0].strip():
            entries.append(self._make_entry("personal", "Header Info",
                                            parts[0].strip(), source))
        for i in range(1, len(parts) - 1, 3):
            title = parts[i + 1].strip()
            content = parts[i + 2].strip()
            if not content:
                continue
            entry_type = classify_section(title)
            for chunk in self._chunks(content):
                entries.append(self._make_entry(entry_type, title, chunk, source))
        return entries

    def _entries_from_plain_text(self, source: str, text: str) -> list[dict]:
        fields = extract_structured_fields(text[:2000])
        blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
        entries = []
        if fields:
            info = "\n".join(f"{k.capitalize()}: {v}" for k, v in fields.items())
            entries.append(self._make_entry("personal", "Contact Info", info, source))
        for block in blocks:
            first_line = block.splitlines()[0][:80].strip()
            entry_type = classify_section(first_line)
            for chunk in self._chunks(block):
                entries.append(self._make_entry(entry_type, first_line or "Resume Content",
                                                chunk, source))
        return entries

    def _chunks(self, text: str) -> list[str]:
        text = text.strip()
        if len(text) <= self.MAX_CHUNK_CHARS:
            return [text] if text else []
        chunks = []
        paragraphs = re.split(r"\n\s*\n", text)
        current = ""
        for para in paragraphs:
            if len(current) + len(para) + 2 > self.MAX_CHUNK_CHARS and current:
                chunks.append(current.strip())
                current = ""
            current += ("\n\n" if current else "") + para
        if current.strip():
            chunks.append(current.strip())
        return chunks

    def _make_entry(self, entry_type: str, title: str, content: str, source: str) -> dict:
        return {
            "id": stable_id(entry_type, title, content[:300]),
            "document": content,
            "metadata": {
                "entry_type": entry_type,
                "title": (title or "Untitled")[:120],
                "source": source[:200],
            },
        }

    def structured_doc(self, fields: dict) -> Optional[dict]:
        """Builds a single RAG-searchable doc out of structured contact fields."""
        if not fields:
            return None
        labels = {
            "full_name": "Full Name", "email": "Email", "phone": "Phone",
            "location": "Location", "linkedin": "LinkedIn", "github": "GitHub",
            "portfolio": "Portfolio", "website": "Website",
        }
        lines = [f"{labels[k]}: {v}" for k, v in fields.items()
                 if v and k in labels]
        if not lines:
            return None
        content = "\n".join(lines)
        return {
            "id": "structured-contact-fields",
            "document": content,
            "metadata": {"entry_type": "personal", "title": "Contact Details",
                         "source": "onboarding-form"},
        }
