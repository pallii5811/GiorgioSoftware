#!/usr/bin/env bash
# Re-run only the 2 CRAWL_CAP canary leads after RC-09 (fresh frontier).
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG=/tmp/k3-micro10b-capretry.log
IDS="cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q"

if pgrep -f 'k3-micro-canary10|production-revalidate-sanita-v3' >/dev/null; then
  echo "ABORT: engine running"; pgrep -af 'k3-micro|revalidate-sanita' || true; exit 3
fi

# Force due now
python3 - <<PY
import json, time
from pathlib import Path
cp_path=Path("$W/data/revalidation/checkpoint.json")
cp=json.loads(cp_path.read_text())
now=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
for i in "$IDS".split(","):
  if i in cp.get("retryQueue",{}):
    cp["retryQueue"][i]["nextRetryAt"]=now
    # clear frontier pointers so even old code would fresh-start; RC-09 also blocks reuse
    cp["retryQueue"][i]["lastReason"]="CRAWL_CAP"
    print("due", i)
cp_path.write_text(json.dumps(cp, indent=2))
PY

export DATABASE_URL="file:$W/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true FORCE_RESCAN_PUB=1
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export REVALIDATE_CHECKPOINT="$W/data/revalidation/checkpoint.json"
export REVALIDATE_OUT_DIR="$W/data/revalidation"
export FRONTIER_DB_PATH="$W/data/revalidation/frontiers/boot.sqlite"
export TESSDATA_PREFIX="$APP/.tesseract-cache"
export CRAWL_HTML_URL_CAP=200
export CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
export REVALIDATE_LEAD_WALL_MS=2700000
export K3_IDS="$IDS"
export K3_OUT="$W/data/k3-stopship/MICRO_CANARY10_CAPRETRY.json"
export K3_WORKDIR="$W" K3_APP="$APP"
export K3_GLOBAL_TIMEOUT_MS=7200000
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
: > "$LOG"
echo "capretry_start $(date -u -Iseconds)" | tee -a "$LOG"
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 3
head -20 "$LOG"
