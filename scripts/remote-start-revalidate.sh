#!/usr/bin/env bash
# Start shadow revalidation on Hetzner green tree (resumable).
set -euo pipefail
APP=/opt/leadsniper-green
SHADOW=$(ls -1t /opt/leadsniper/shadow/giorgio-shadow-*.db | head -1)
WORKDIR=/opt/leadsniper-revalidate
mkdir -p "$WORKDIR/data/revalidation/results" "$WORKDIR/data/revalidation/frontiers" "$WORKDIR/logs"
# Use green code + dedicated work copy of shadow so smoke DB stays clean
cp -a "$SHADOW" "$WORKDIR/shadow-revalidate.db"
rsync -a --delete --exclude=.git --exclude=node_modules --exclude=.next "$APP/" "$WORKDIR/app/" 2>/dev/null || {
  mkdir -p "$WORKDIR/app"
  rsync -a --delete --exclude=.git "$APP/" "$WORKDIR/app/"
}
cd "$WORKDIR/app"
if [ ! -d node_modules ]; then npm ci; node scripts/prisma-smart.mjs; fi
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export REVALIDATE_CONCURRENCY="${REVALIDATE_CONCURRENCY:-2}"
export REVALIDATE_DUAL_HOT="${REVALIDATE_DUAL_HOT:-1}"
export REVALIDATE_CHECKPOINT="$WORKDIR/data/revalidation/checkpoint.json"
export FRONTIER_DB_PATH="$WORKDIR/data/revalidation/frontiers/boot.sqlite"
# Link results into workdir
mkdir -p "$WORKDIR/app/data/revalidation"
ln -sfn "$WORKDIR/data/revalidation/results" "$WORKDIR/app/data/revalidation/results"
ln -sfn "$WORKDIR/data/revalidation/frontiers" "$WORKDIR/app/data/revalidation/frontiers"
ln -sfn "$WORKDIR/data/revalidation/checkpoint.json" "$WORKDIR/app/data/revalidation/checkpoint.json" 2>/dev/null || true
LOG="$WORKDIR/logs/revalidate-$(date -u +%Y%m%dT%H%M%SZ).log"
nohup npx tsx scripts/production-revalidate-sanita-v2.mjs >>"$LOG" 2>&1 &
echo $! > "$WORKDIR/revalidate.pid"
echo "REVALIDATE_STARTED pid=$(cat $WORKDIR/revalidate.pid) log=$LOG shadow=$WORKDIR/shadow-revalidate.db"
