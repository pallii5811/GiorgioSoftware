#!/usr/bin/env bash
# Start micro-canary 10 after RC-07 worker patch. Does NOT start 877.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG="$W/data/k3-stopship/micro-canary10-run2.log"
IDS="cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqkld5rk009b108ekvol7g87,cmqkld5s700a8108eti0nofjv,cmql46eia000ac9w78xh0rxdl,cmqmaor4t00389g5c2iuoauuw,cmqn40oou0002kwqdfi0ipn2g,cmqkld5s0009u108eghihpoxi"

if pgrep -f 'k3-micro-canary10|production-revalidate-sanita-v3' >/dev/null; then
  echo "ABORT: engine already running"
  pgrep -af 'k3-micro-canary10|production-revalidate-sanita-v3' || true
  exit 3
fi

grep -q 'FORCE_RESCAN_PUB' "$APP/scripts/production-revalidate-sanita-worker.mjs" || {
  echo "ABORT: RC-07 missing on worker"
  exit 4
}

export DATABASE_URL="file:$W/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export FORCE_RESCAN_PUB=1
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export REVALIDATE_CHECKPOINT="$W/data/revalidation/checkpoint.json"
export REVALIDATE_OUT_DIR="$W/data/revalidation"
export FRONTIER_DB_PATH="$W/data/revalidation/frontiers/boot.sqlite"
export TESSDATA_PREFIX="$APP/.tesseract-cache"
export K3_IDS="$IDS"
export K3_OUT="$W/data/k3-stopship/MICRO_CANARY10_RESULTS.json"
export K3_WORKDIR="$W"
export K3_APP="$APP"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
: > "$LOG"
echo "starting canary2 $(date -u -Iseconds)" | tee -a "$LOG"
nohup node scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 2
head -20 "$LOG"
