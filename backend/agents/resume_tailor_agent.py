from typing import Generator
import json

RESUME_TAILOR_SYSTEM_PROMPT = """You are an expert resume writer. Tailor the candidate's master LaTeX resume to a specific job description.

Rules:
1. Output ONLY raw LaTeX source. Start with \\documentclass and end with \\end{{document}}.
2. No markdown code fences, no explanations, no comments before or after the LaTeX.
3. Preserve the preamble (\\documentclass through \\begin{{document}}), all packages, macros, and layout commands EXACTLY as given.
4. Edit ONLY content: reorder/reword bullet points, adjust the summary, reorder skills to emphasize what matches the job description keywords.
5. NEVER invent employers, job titles, dates, schools, degrees, or technologies that are not in the master resume or candidate context.
6. Keep roughly the same number of bullets per section; tighten wording rather than expanding so it still fits one page.
7. Naturally mirror important keywords from the job description where they truthfully apply.

Job Applying To: {job_context}

Job Description:
{job_doc}

Candidate Extra Context:
{profile_context}

Master LaTeX Resume:
{master_tex}

Output the tailored LaTeX resume now:"""


class ResumeTailorAgent:
    def __init__(self, host: str = "http://127.0.0.1:11434"):
        import ollama

        self.client = ollama.Client(host=host)

    def generate_tailored(self, master_tex: str, job_doc: str, job_context: str,
                          profile_context: str, model: str = "qwen2.5:3b") -> Generator[str, None, None]:
        """Streams NDJSON lines: {"type":"thinking"|"content","text":...}."""
        prompt = RESUME_TAILOR_SYSTEM_PROMPT.format(
            job_context=job_context,
            job_doc=job_doc[:4000],
            profile_context=profile_context[:2000] or "(none)",
            master_tex=master_tex[:9000],
        )
        response = self.client.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            stream=True,
            think=False,
            keep_alive="30m",
            options={
                "temperature": 0.25,
                "num_predict": 3072,
                "num_ctx": 4096,
                "num_thread": 4,
            },
        )
        for chunk in response:
            msg = getattr(chunk, "message", None)
            if not msg and isinstance(chunk, dict):
                msg = chunk.get("message", {})
                thinking = msg.get("thinking", "")
                content = msg.get("content", "")
            else:
                thinking = getattr(msg, "thinking", "") if msg else ""
                content = getattr(msg, "content", "") if msg else ""
            if thinking:
                yield json.dumps({"type": "thinking", "text": thinking}) + "\n"
            if content:
                yield json.dumps({"type": "content", "text": content}) + "\n"
