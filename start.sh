#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN="\033[32m"; YELLOW="\033[33m"; RESET="\033[0m"

if ! pgrep -x ollama &>/dev/null; then
  echo -e "${YELLOW}▸ Starting Ollama...${RESET}"
  if command -v brew &>/dev/null; then
    brew services start ollama 2>/dev/null || ollama serve &>/dev/null &
  else
    ollama serve &>/dev/null &
  fi
  sleep 3
fi

# Activate venv if present
if [[ -f .venv/bin/activate ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# Kill stale backend
pkill -f "uvicorn.*server:app" 2>/dev/null || true
sleep 1

PYTHON_BIN="python"
command -v .venv/bin/python &>/dev/null && PYTHON_BIN=".venv/bin/python"

echo -e "${GREEN}▸ Starting backend on http://127.0.0.1:8000 ...${RESET}"
nohup "$PYTHON_BIN" -m uvicorn backend.server:app --host 127.0.0.1 --port 8000 --app-dir backend > backend/server.log 2>&1 &
sleep 3

if curl -fsS http://127.0.0.1:8000/ >/dev/null 2>&1; then
  echo -e "${GREEN}▸ Backend ready: http://127.0.0.1:8000${RESET}"
else
  echo -e "${YELLOW}▸ Backend warming up — tail -f backend/server.log${RESET}"
fi
