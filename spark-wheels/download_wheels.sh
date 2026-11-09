#!/usr/bin/env bash
# Automated wheel depot download helper for Gemini Spark companion tier
set -euo pipefail

DEPOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPOT_DIR"

echo "============================================================"
echo " Gemini Spark — Fetching Offline Wheels"
echo " Target Directory: $DEPOT_DIR"
echo "============================================================"

pip download -r requirements.txt -d "$DEPOT_DIR"

echo "[SUCCESS] Offline wheel packages staged in $DEPOT_DIR."
