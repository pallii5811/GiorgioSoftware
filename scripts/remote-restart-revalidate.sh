#!/usr/bin/env bash
set -euo pipefail
PIDFILE=/opt/leadsniper-revalidate/revalidate.pid
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 2
fi
SHA=$(cat /opt/leadsniper-green/RELEASE_SHA)
cd /opt/leadsniper-revalidate/app
export GIT_HEAD="$SHA"
export DATABASE_URL="file:/opt/leadsniper-revalidate/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export REVALIDATE_CONCURRENCY=2
export REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
LOG=/opt/leadsniper-revalidate/logs/revalidate-restart2.log
nohup npx tsx scripts/production-revalidate-sanita-v2.mjs >>"$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 5
head -n 5 "$LOG"
echo "PID=$(cat $PIDFILE) SHA=$SHA"
