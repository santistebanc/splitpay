#!/usr/bin/env bash
# Start the SplitPay dev server with hot reload (Fast Refresh).
#
# Usage:
#   npm run dev              # interactive — press w (web), a (Android), i (iOS)
#   npm run dev:web          # open the web app directly
#   npm run dev:android      # open on an Android emulator/device
#   npm run dev:ios          # open on an iOS simulator
#   npm run dev:tunnel       # interactive over a public tunnel (best for phones)
#
# Edits to App.tsx / src/** hot-reload automatically — no manual rebuild.
# Keep this process running while you develop.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/apps/mobile"

is_wsl() { grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; }

if is_wsl; then
  WSL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "[dev] WSL2 detected."
  echo "[dev]   • Web from Windows:  http://localhost:8081   (recommended)"
  echo "[dev]     if that refuses, try:  http://${WSL_IP:-<wsl-ip>}:8081"
  echo "[dev]   • Real phone (Expo Go): use 'npm run dev:tunnel' — the WSL IP is not"
  echo "[dev]     reachable from your phone on WSL2's NAT network."
  echo
fi

TARGET="${1:-}"
case "$TARGET" in
  web)     exec npx expo start --web ;;
  android) exec npx expo start --android ;;
  ios)     exec npx expo start --ios ;;
  tunnel)  exec npx expo start --tunnel ;;
  "")      exec npx expo start ;;
  *) echo "Unknown target '$TARGET' (use: web | android | ios | tunnel)"; exit 1 ;;
esac
