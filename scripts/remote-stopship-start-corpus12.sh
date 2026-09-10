#!/usr/bin/env bash
# One-shot corpus of demoted TECHNICAL leads. Does NOT enable giorgio-revalidate systemd / 877.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
IDS=$(tr '\n' ',' </tmp/stopship-forensic/tech-ids.txt | sed 's/,$//')
LOG=/opt/leadsniper-revalidate/logs/stopship-corpus12.log
mkdir -p /opt/leadsniper-revalidate/logs

echo "CORPUS_IDS=$IDS"
systemctl is-active giorgio-revalidate || true
test "$(systemctl is-active giorgio-revalidate || true)" != "active"

cd "$APP"
export DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export TOTAL_WORKERS=1
export REVALIDATE_CONCURRENCY=1
export REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
export REVALIDATE_OUT_DIR=/opt/leadsniper-revalidate/data/revalidation
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export CRAWL_HTML_URL_CAP=60
export CRAWL_RUN_MAX_WALL_CLOCK_MS=3600000
export CRAWL_MAX_HTML_PER_SLICE=16
export PER_HOST_CONCURRENCY=1
export REVALIDATE_LEAD_WALL_MS=3600000
export REVALIDATE_RETRY_BASE_MS=60000
export REVALIDATE_IDS="$IDS"
export GIT_HEAD=$(cat RELEASE_SHA 2>/dev/null || cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null || echo fe8b677)
export RELEASE_SHA=$GIT_HEAD
export NODE_OPTIONS=--max-old-space-size=3072
export ALLOW_LIVE_REVALIDATE=0

# flock prevents clash with systemd parent
nohup /usr/bin/flock -n /opt/leadsniper-revalidate/revalidate.parent.lock \
  npx tsx scripts/production-revalidate-sanita-v3.mjs \
  >"$LOG" 2>&1 &
echo $! > /tmp/stopship-forensic/corpus12.pid
echo "STARTED pid=$(cat /tmp/stopship-forensic/corpus12.pid) log=$LOG"
sleep 3
head -20 "$LOG" || true
echo CORPUS12_STARTED
