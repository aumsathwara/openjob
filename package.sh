#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])" 2>/dev/null || echo "1.0")
OUT="openjob-extension-v${VERSION}.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json background.js content/ offscreen/ onboarding/ popup/ scripts/ vendor/ -x "*.DS_Store" 2>/dev/null
echo "▸ Packaged $OUT ($(du -h "$OUT" | cut -f1))"
echo "  Upload this zip at chrome://extensions or to the Chrome Web Store."
