#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
OUT=/opt/leadsniper-revalidate/data/stopship-retry11-rerun
LOG=$OUT/targeted.log
IDS=$(python3 -c "import json; print(','.join(json.load(open('$OUT/ids.json'))['ids']))")

while IFS= read -r line; do
  case "$line" in
    *=*) export "$line" ;;
  esac
done < <(systemctl show giorgio-revalidate -p Environment --value | tr ' ' '\n')

export APPLY_LIVE=0
export DISABLE_LIVE_DB=true
export TOTAL_WORKERS=1
export REVALIDATE_CONCURRENCY=1
export PER_HOST_CONCURRENCY=1
export CRAWL_HTML_URL_CAP=100
export CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
export CRAWL_MAX_HTML_PER_SLICE=24
export REVALIDATE_LEAD_WALL_MS=3300000
export REVALIDATE_SLICE_WALL_MS=3300000
export OCR_TIMEOUT_MS=180000
export PDF_FETCH_TIMEOUT_MS=60000
export MAX_DOCUMENT_RETRIES=3
export REVALIDATE_MAX_RETRY=5
export REVALIDATE_DUAL_HOT=0
export REVALIDATE_OUT_DIR=$OUT
export REVALIDATE_CHECKPOINT=$OUT/checkpoint.json
export REVALIDATE_IDS="$IDS"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
export CHROMIUM_PATH=/snap/bin/chromium
export GIT_HEAD=40574b7263c0834da51404d25cfc1f375ab0db36
export RELEASE_SHA=$GIT_HEAD

cd "$APP"
# ensure prod still paused
systemctl stop giorgio-revalidate || true
exec flock -n "$OUT/targeted.parent.lock" -c "node scripts/production-revalidate-sanita-v3.mjs" >>"$LOG" 2>&1
