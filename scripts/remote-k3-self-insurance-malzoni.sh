#!/usr/bin/env bash
# Self-insurance fix: demote Malzoni (+ optional Pini/Marcianise) and re-run.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG=/tmp/k3-self-insurance-malzoni.log
# Default: Malzoni only. Override: K3_IDS=malzoni,pini,marc
IDS="${K3_IDS:-cmqktyimz000i111hygme29nh}"

if pgrep -af 'k3-micro-canary10|production-revalidate-sanita-v3' | grep -v pgrep >/dev/null; then
  echo "ABORT engine running"; pgrep -af 'k3-micro|production-revalidate' | grep -v pgrep || true; exit 3
fi

echo "SELF_INSURANCE_SHA=$(cat $APP/RELEASE_SHA 2>/dev/null || echo unknown)" | tee "$LOG"
grep -n "SELF_INSURANCE\|selfInsurance\|detectSelfInsurance" \
  "$APP/src/lib/sanita/scan-engine.ts" \
  "$APP/src/lib/sanita/self-insurance.ts" \
  "$APP/src/lib/sanita/can-emit-published.ts" | head -40 | tee -a "$LOG"

python3 - <<PY
import json, time
from pathlib import Path
cp_path = Path("$W/data/revalidation/checkpoint.json")
cp = json.loads(cp_path.read_text())
now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
ids = [x.strip() for x in "$IDS".split(",") if x.strip()]
cp["inProgress"] = {}
for i in ids:
  prev = cp.get("terminal", {}).pop(i, None)
  if prev:
    print("demoted", i, prev.get("processingState"))
  cp.setdefault("retryQueue", {})[i] = {
    "attempts": int((cp.get("retryQueue", {}).get(i) or {}).get("attempts") or 0),
    "nextRetryAt": now,
    "lastError": "SELF_INSURANCE_RECLASSIFY",
    "lastReason": "CRAWL_CAP",
    "firstSeenAt": now,
  }
  cp["retryQueue"][i].pop("frontierPath", None)
  cp["retryQueue"][i].pop("lastRunId", None)
cp_path.write_text(json.dumps(cp, indent=2))
print("due", ids)
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
export CRAWL_NODE_STALL_MS=180000
export K3_IDS="$IDS"
export K3_OUT="$W/data/k3-stopship/SELF_INSURANCE_MALZONI.json"
export K3_WORKDIR="$W" K3_APP="$APP" K3_GLOBAL_TIMEOUT_MS=7200000
export K3_DISABLE_AUDIT_STOP=1
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
echo "start $(date -u -Iseconds)" | tee -a "$LOG"
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 5
head -40 "$LOG"
