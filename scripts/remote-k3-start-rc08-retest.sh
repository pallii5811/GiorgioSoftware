#!/usr/bin/env bash
# RC-08 retest: only the 5 known-PUB canary leads (not full 10, not 877).
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG="$W/data/k3-stopship/micro-canary-rc08-retest.log"
# Pini già PUBLISHED (terminal valido RC-08d) — restano i 4 non ancora rieseguiti.
IDS="${K3_RETEST_IDS:-cmqktyimz000i111hygme29nh,cmqkld5rk009b108ekvol7g87,cmql4d399000uc9w7yzw2dgac,cmql4qrif000yc9w74e0tmpqt}"

if pgrep -f 'k3-micro-canary10|production-revalidate-sanita-v3' >/dev/null; then
  echo "ABORT: engine running"; pgrep -af 'k3-micro|revalidate-sanita' || true; exit 3
fi

export DATABASE_URL="file:$W/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true FORCE_RESCAN_PUB=1
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export REVALIDATE_CHECKPOINT="$W/data/revalidation/checkpoint.json"
export REVALIDATE_OUT_DIR="$W/data/revalidation"
export FRONTIER_DB_PATH="$W/data/revalidation/frontiers/boot.sqlite"
export TESSDATA_PREFIX="$APP/.tesseract-cache"
export K3_IDS="$IDS"
export K3_OUT="$W/data/k3-stopship/MICRO_CANARY_RC08_RETEST.json"
export K3_WORKDIR="$W" K3_APP="$APP"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
: > "$LOG"
echo "rc08_retest_start $(date -u -Iseconds)" | tee -a "$LOG"
# tsx, non node: l'audit del monitor importa frontier-store.ts che usa alias @/lib
# (sotto node puro → ERR_MODULE_NOT_FOUND contato come falsa violazione PUB/HOT).
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 2
head -25 "$LOG"
