#!/bin/bash
set -euo pipefail
CANARY=/opt/leadsniper-revalidate/data/stopship-canary20
APP=/opt/leadsniper-revalidate/app
LOG=$CANARY/canary20-drain.log

# only the 4 remaining retry ids
IDS=$(python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/stopship-canary20/checkpoint.json").read_text())
print(",".join((cp.get("retryQueue") or {}).keys()))
PY
)
if [ -z "$IDS" ]; then
  echo "NO_RETRY_LEFT"
  exit 0
fi
echo "DRAIN_IDS=$IDS"

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
# force due now for the 4
python3 - <<'PY'
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
cp_path=Path("/opt/leadsniper-revalidate/data/stopship-canary20/checkpoint.json")
cp=json.loads(cp_path.read_text())
now=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z"
for lid,m in (cp.get("retryQueue") or {}).items():
    m["nextRetryAt"]=now
    cp["retryQueue"][lid]=m
cp["inProgress"]={}
cp["updatedAt"]=now
cp_path.write_text(json.dumps(cp, indent=2, ensure_ascii=False))
print("forced_due", list((cp.get("retryQueue") or {}).keys()))
PY

flock -n "$CANARY/canary.parent.lock" -c "node scripts/production-revalidate-sanita-v3.mjs" >>"$LOG" 2>&1
echo DRAIN_EXIT:$?
python3 /opt/leadsniper-revalidate/app/scripts/eval-stopship-canary20.py
