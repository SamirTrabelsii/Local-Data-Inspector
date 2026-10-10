#!/usr/bin/env bash
# Dev mode: API with auto-reload on :8765, Vite with HMR on :5173. Ctrl+C stops both.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
uv run --directory "$root/backend" ldi --no-browser --reload &
api=$!
trap 'kill $api 2>/dev/null' EXIT
(sleep 2 && (open http://localhost:5173 2>/dev/null || xdg-open http://localhost:5173 2>/dev/null)) &
npm --prefix "$root/frontend" run dev
