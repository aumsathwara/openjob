#!/bin/bash
set -e

# openjob — one-line Mac installer
# Usage:  curl -fsSL https://raw.githubusercontent.com/aumsathwara/openjob/main/install.sh | bash
#    or:  git clone https://github.com/aumsathwara/openjob.git && cd openjob && bash install.sh

REPO="aumsathwara/openjob"
INSTALL_DIR="$HOME/openjob"
OLLAMA_MODELS=("qwen2.5:1.5b" "qwen2.5:3b")

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
info()  { echo -e "${GREEN}▸ $*${RESET}"; }
warn()  { echo -e "${YELLOW}▸ $*${RESET}"; }
fail()  { echo -e "${RED}✘ $*${RESET}"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || warn "This installer targets macOS — continuing anyway."

# ── 1. Homebrew ──────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -f /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"; fi
else
  info "Homebrew ✓  $(brew --version | head -1)"
fi

# ── 2. System deps ─────────────────────────────────────────
info "Installing system dependencies (python, ollama)..."
brew update -q 2>/dev/null || true
brew install python@3.11 ollama 2>/dev/null || brew upgrade python@3.11 ollama 2>/dev/null || true

# Optional: LaTeX for local PDF compilation (best-effort, no fail)
if ! command -v pdflatex &>/dev/null; then
  warn "pdflatex not found — local PDF compilation will be skipped."
  warn "  To enable:  brew install --cask mactex-no-gui  (large, ~4GB)"
fi

# ── 3. Clone / update repo ─────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not pull — using local copy."
else
  if [[ -d "$INSTALL_DIR" ]]; then
    warn "$INSTALL_DIR exists but is not a git repo — backing up."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%Y%m%d%H%M%S)"
  fi
  # If we're already inside the repo (curl|bash from inside clone), skip clone
  if [[ -f ./manifest.json && -f ./backend/server.py ]]; then
    INSTALL_DIR="$PWD"
    info "Running from inside repo: $INSTALL_DIR"
  else
    info "Cloning $REPO → $INSTALL_DIR ..."
    git clone "https://github.com/${REPO}.git" "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"

# ── 4. Python deps ─────────────────────────────────────────
info "Installing Python dependencies..."
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r backend/requirements.txt -q
info "Python deps ✓"

# ── 5. Ollama service + models ─────────────────────────────
if ! pgrep -x ollama &>/dev/null; then
  info "Starting Ollama..."
  brew services start ollama 2>/dev/null || ollama serve &>/dev/null &
  sleep 3
fi

for model in "${OLLAMA_MODELS[@]}"; do
  if ollama list 2>/dev/null | grep -q "$model"; then
    info "Model $model ✓ (already pulled)"
  else
    info "Pulling $model (this may take a few minutes)..."
    ollama pull "$model"
  fi
done

# ── 6. Chrome extension note ───────────────────────────────
info "Installing Chrome extension..."
EXT_DIR="$INSTALL_DIR"
cat <<EOF

  ${BOLD}Chrome Extension — manual step (30 seconds):${RESET}
    1. Open  ${BOLD}chrome://extensions${RESET}
    2. Enable ${BOLD}Developer mode${RESET} (top-right toggle)
    3. Click ${BOLD}Load unpacked${RESET} → select:
       ${BOLD}$EXT_DIR${RESET}
    4. Pin the extension, then open its ${BOLD}Options${RESET} page to set up your profile.

EOF

# ── 7. Start backend ───────────────────────────────────────
info "Starting backend on http://127.0.0.1:8000 ..."
# Kill stale instance if any
pkill -f "uvicorn.*server:app" 2>/dev/null || true
sleep 1
nohup .venv/bin/python -m uvicorn backend.server:app --host 127.0.0.1 --port 8000 --app-dir backend > backend/server.log 2>&1 &
sleep 3

if curl -fsS http://127.0.0.1:8000/ >/dev/null 2>&1; then
  info "Backend ✓  http://127.0.0.1:8000"
else
  warn "Backend may still be warming up — check backend/server.log"
fi

cat <<EOF

  ${GREEN}${BOLD}openjob is ready!${RESET}
  ─────────────────────────────────────────
  Backend:   http://127.0.0.1:8000  (logs: backend/server.log)
  Extension: chrome://extensions → openjob
  Models:    ${OLLAMA_MODELS[*]}

  ${BOLD}Quick start:${RESET}
    1. Open the extension's ${BOLD}Options${RESET} page → upload your resume (.tex/.pdf)
    2. Browse a job posting → click ${BOLD}Index Active Page${RESET}
    3. ${BOLD}Tailor${RESET} tab → Push to Overleaf or Download PDF
    4. On any application page → ${BOLD}Apply${RESET} → Autofill

  ${BOLD}Commands:${RESET}
    ./start.sh     — start backend + ollama
    ./stop.sh      — stop backend
    ./install.sh   — re-run installer / update

EOF
