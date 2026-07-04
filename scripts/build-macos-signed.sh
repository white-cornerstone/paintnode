#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/.env.macos-signing.local"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing $CONFIG_FILE" >&2
  echo "Create it with APPLE_SIGNING_IDENTITY, APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH." >&2
  exit 1
fi

source "$CONFIG_FILE"

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY_PATH"
fi

cd "$ROOT_DIR"
npm run tauri:build -- --bundles app,dmg "$@"
