#!/usr/bin/env bash
# Kill hung blocker01, sync RC-11c DNS skip, restart Arsenio+Analogous only.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG=/tmp/k3-blocker01-retry.log

# Stop hung canary/worker/chrome from prior run
pkill -f 'scripts/k3-micro-canary10.mjs' 2>/dev/null || true
pkill -f 'production-revalidate-sanita-v3.mjs' 2>/dev/null || true
pkill -f 'production-revalidate-sanita-worker.mjs' 2>/dev/null || true
sleep 2
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 1
if pgrep -af 'k3-micro-canary10|production-revalidate-sanita-v3|production-revalidate-sanita-worker' | grep -v pgrep >/dev/null; then
  echo "ABORT: still running"; pgrep -af 'k3-micro|production-revalidate' || true; exit 3
fi

cp /tmp/rc11-src/src/lib/sanita/scan-engine.ts "$APP/src/lib/sanita/scan-engine.ts"
echo "synced scan-engine RC-11c"

# Clear stale inProgress; re-queue 3 leads with fresh frontier
python3 - <<'PY'
import json, time
from pathlib import Path
cp_path=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(cp_path.read_text())
now=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
ids=[
  "cmqp7cqya00011q5bkqf3ox8q",
  "cmqktyimz000i111hygme29nh",
  "cmqklex5q00bh108eq9blm01k",
]
cp["inProgress"]={}
for i in ids:
  cp.get("terminal",{}).pop(i, None)
  prev=cp.get("retryQueue",{}).get(i) or {}
  cp.setdefault("retryQueue",{})[i]={
    "attempts": int(prev.get("attempts") or 0)+1,
    "nextRetryAt": now,
    "lastError": "SITEMAP_UNRESOLVED",
    "lastReason": "SITEMAP_UNRESOLVED",
    "firstSeenAt": now,
  }
print("due", ids, "inProgress_cleared")
cp_path.write_text(json.dumps(cp, indent=2))
PY

# drop alt frontier leftover
rm -f "$APP/data/shadow/frontier/analyze-alt-cmqp7cqya00011q5bkqf3ox8q.sqlite"* 2>/dev/null || true

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
export CRAWL_NODE_STALL_MS=120000
export K3_IDS="cmqp7cqya00011q5bkqf3ox8q,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k"
export K3_OUT="$W/data/k3-stopship/BLOCKER01_RETRY.json"
export K3_WORKDIR="$W" K3_APP="$APP" K3_GLOBAL_TIMEOUT_MS=10800000
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
: > "$LOG"
echo "blocker01b_start $(date -u -Iseconds)" | tee -a "$LOG"
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 5
head -40 "$LOG"
