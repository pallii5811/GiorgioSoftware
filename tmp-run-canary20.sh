#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
CANARY=/opt/leadsniper-revalidate/data/stopship-canary20
IDS=$(python3 -c "import json; print(','.join(json.load(open('$CANARY/ids.json'))['ids']))")
LOG=$CANARY/canary20.log
# Export env from unit
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
export REVALIDATE_OUT_DIR=$CANARY
export REVALIDATE_CHECKPOINT=$CANARY/checkpoint.json
export REVALIDATE_IDS="$IDS"
export REVALIDATE_DUAL_HOT=0

cd "$APP"
# single parent flock on canary lock (not prod)
exec flock -n "$CANARY/canary.parent.lock" -c "node scripts/production-revalidate-sanita-v3.mjs >>'$LOG' 2>&1"
