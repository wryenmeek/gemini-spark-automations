#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASP="$ROOT_DIR/node_modules/.bin/clasp"

echo "============================================================"
echo " Gemini Spark — Google Apps Script Deployment Suite (clasp)"
echo "============================================================"

if [ ! -f "$HOME/.clasprc.json" ]; then
  echo "Step 1: Authenticating clasp with Google Apps Script API..."
  echo "  Note: Ensure the Apps Script API is enabled at:"
  echo "  https://script.google.com/home/usersettings"
  "$CLASP" login
fi

deploy_bound_project() {
  local dir="$1"
  local title="$2"
  local parent_id="$3"

  echo ""
  echo "------------------------------------------------------------"
  echo "Deploying: $title"
  echo "Directory: $dir"
  echo "Parent Sheet ID: $parent_id"
  echo "------------------------------------------------------------"
  cd "$ROOT_DIR/projects/$dir"

  if [ ! -f ".clasp.json" ]; then
    cp Code.gs Code.gs.bak
    cp appsscript.json appsscript.json.bak
    if ! "$CLASP" create --title "$title" --parentId "$parent_id" --rootDir .; then
      mv -f Code.gs.bak Code.gs
      mv -f appsscript.json.bak appsscript.json
      return 1
    fi
    mv -f Code.gs.bak Code.gs
    mv -f appsscript.json.bak appsscript.json
  fi

  "$CLASP" push --force
  echo "[SUCCESS] Pushed $title to Apps Script!"
}

deploy_bound_project \
  "receipts-ingestion" \
  "Financial-Receipts-Ingestion" \
  "194nQzKDYo0Bt8tfO1P1UBAD-dtDgSb7CWDatv61-ADI"

deploy_bound_project \
  "writing-style-index" \
  "Writing-Style-Index-Automation" \
  "1HPY3pKrgzeJr1FMLiK_UNyNJcfPTanJoPRL3ikF_nA8"

deploy_bound_project \
  "drive-tagging" \
  "Drive-Tagging-Automation" \
  "1XE78-Gae0a5DfkuC0lJcy62XjreqPIPovy8LuoAT3gA"

echo ""
echo "------------------------------------------------------------"
echo "Deploying: MCDM Archive Knowledge Graph Ingestion"
echo "Directory: knowledge-graph-ingestion"
echo "------------------------------------------------------------"
cd "$ROOT_DIR/projects/knowledge-graph-ingestion"
"$CLASP" push --force
echo "[SUCCESS] Pushed MCDM Archive Knowledge Graph Ingestion to Apps Script!"

echo ""
echo "============================================================"
echo " All 4 Google Apps Script Projects Deployed Successfully!"
echo "============================================================"
