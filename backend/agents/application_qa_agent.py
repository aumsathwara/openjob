APPLICATION_QA_SYSTEM_PROMPT = """You are answering a job application question AS the candidate (first person).

Candidate Profile Context:
{context}

Applying To: {job_context}
Question: {question}

Rules:
1. Answer ONLY from the candidate profile context. Never invent employers, dates, schools, metrics, or skills.
2. Be direct and concise: 1-4 sentences (or one word/short phrase if the question asks for that, e.g. yes/no, availability).
3. Sound natural and confident, like a real applicant - not an AI.
4. If the context is missing information needed to answer, reply starting exactly with:
NEEDS_REVIEW: <one short sentence about what info is needed>
5. Do not add any preamble, disclaimers, or quotes.

Answer:"""


class ApplicationQAAgent:
    """Answers employer application questions using RAG over the candidate's profile."""

    def __init__(self, host: str = "http://127.0.0.1:11434"):
        import ollama

        self.client = ollama.Client(host=host)

    def answer(self, question: str, context: str, job_context: str,
               model: str = "qwen2.5:1.5b") -> str:
        prompt = APPLICATION_QA_SYSTEM_PROMPT.format(
            context=context,
            job_context=job_context or "Unknown position",
            question=question,
        )
        response = self.client.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            think=False,
            keep_alive="30m",
            options={
                "temperature": 0.2,
                "num_predict": 220,
                "num_ctx": 2048,
                "num_thread": 4,
                "top_k": 30,
            },
        )
        msg = getattr(response, "message", None)
        content = getattr(msg, "content", "") if msg else ""
        if not content and isinstance(response, dict):
            content = response.get("message", {}).get("content", "")
        return content.strip()
