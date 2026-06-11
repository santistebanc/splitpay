#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR/apps/mobile"
npm run serve:web &
WEB_PID=$!

echo "SplitPay web: http://127.0.0.1:8082"
wait "$WEB_PID"
