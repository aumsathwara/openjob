from typing import Generator
import ollama
import json
from agents.prompts.summarizer_agent_prompt import SUMMARIZER_SYSTEM_PROMPT, RAG_CHAT_SYSTEM_PROMPT

class SummarizerAgent:
    def __init__(self, host: str = "http://127.0.0.1:11434"):
        self.client = ollama.Client(host=host)

    def generate_summary(self, title: str, company: str, document: str, model: str = "qwen3.5:2b") -> Generator[str, None, None]:
        """Uses ollama.chat streaming for concise reasoning thinking and content."""
        prompt = SUMMARIZER_SYSTEM_PROMPT.format(
            title=title,
            company=company,
            document=document
        )

        response = self.client.chat(
            model=model,
            messages=[{'role': 'user', 'content': prompt}],
            stream=True,
            keep_alive="30m",
            options={
                "temperature": 0.3,
                "num_ctx": 4096,
                "num_thread": 4
            }
        )

        for chunk in response:
            msg = getattr(chunk, 'message', None)
            if not msg and isinstance(chunk, dict):
                msg = chunk.get('message', {})
                thinking = msg.get('thinking', '')
                content = msg.get('content', '')
            else:
                thinking = getattr(msg, 'thinking', '') if msg else ''
                content = getattr(msg, 'content', '') if msg else ''

            if thinking:
                yield json.dumps({"type": "thinking", "text": thinking}) + "\n"
            if content:
                yield json.dumps({"type": "content", "text": content}) + "\n"

    def answer_query(self, context: str, question: str, model: str = "qwen3.5:2b") -> Generator[str, None, None]:
        """Uses ollama.chat streaming for concise reasoning thinking and RAG content."""
        prompt = RAG_CHAT_SYSTEM_PROMPT.format(
            context=context,
            question=question
        )
        
        response = self.client.chat(
            model=model,
            messages=[{'role': 'user', 'content': prompt}],
            stream=True,
            keep_alive="30m",
            options={
                "temperature": 0.0,      # Eliminates creative hesitation; model picks the fastest token
                "num_predict": 128,      # Strict cap on max generated tokens so it cannot trail off or ramble
                "num_ctx": 2048,         # Shrinks context allocation memory for a massive speed boost
                "top_k": 20,             # Narrows token searching pool to process math/logits instantly
                "num_thread": 4          # Matches physical cores for CPU inference
            }
        )
        
        for chunk in response:
            msg = getattr(chunk, 'message', None)
            if not msg and isinstance(chunk, dict):
                msg = chunk.get('message', {})
                thinking = msg.get('thinking', '')
                content = msg.get('content', '')
            else:
                thinking = getattr(msg, 'thinking', '') if msg else ''
                content = getattr(msg, 'content', '') if msg else ''

            if thinking:
                yield json.dumps({"type": "thinking", "text": thinking}) + "\n"
            if content:
                yield json.dumps({"type": "content", "text": content}) + "\n"
