#!/usr/bin/env bash
# Downloads the bundled English Whisper model if missing (CI / Mac builds).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/models/ggml-base.en.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

if [ -f "$DEST" ]; then
  echo "Whisper model ready: $DEST"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "Downloading ggml-base.en.bin (~148 MB) — bundled in the installer..."
curl -L --fail -o "$DEST" "$URL"
echo "Done: $DEST"
