#!/usr/bin/env bash
# Single-lead Arsenio retry after RC-10 audit fix (do not stop on @/lib false positives).
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG=/tmp/k3-arsenio-retry.log
IDS="cmqp7cqya00011q5bkqf3ox8q"

if pgrep -f 'k3-micro-canary10|production-revalidate-sanita-v3' >/dev/null; then
  echo "ABORT: engine running"; exit 3
fi

python3 - <<PY
import json, time
from pathlib import Path
cp_path=Path("$W/data/revalidation/checkpoint.json")
cp=json.loads(cp_path.read_text())
now=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
i="$IDS"
if i in cp.get("terminal",{}):
  t=cp["terminal"].pop(i)
  print("demoted_terminal", t.get("processingState"))
cp.setdefault("retryQueue",{})[i]={
  "attempts": int((cp.get("retryQueue",{}).get(i) or {}).get("attempts") or 0),
  "nextRetryAt": now,
  "lastError": "CRAWL_CAP",
  "lastReason": "CRAWL_CAP",
  "firstSeenAt": now,
}
# drop frontier pointers → fresh under RC-09
cp["retryQueue"][i].pop("frontierPath", None)
cp["retryQueue"][i].pop("lastRunId", None)
cp_path.write_text(json.dumps(cp, indent=2))
print("due", i)
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
export K3_IDS="$IDS" K3_OUT="$W/data/k3-stopship/ARSENIO_RETRY.json"
export K3_WORKDIR="$W" K3_APP="$APP" K3_GLOBAL_TIMEOUT_MS=7200000
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
cp /tmp/k3-rc09/k3-micro-canary10.mjs "$APP/scripts/k3-micro-canary10.mjs" 2>/dev/null || true
: > "$LOG"
echo "arsenio_start $(date -u -Iseconds)" | tee -a "$LOG"
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 3
head -25 "$LOG"
