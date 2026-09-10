#!/usr/bin/env bash
set -uo pipefail
bash /tmp/remote-free-orphans.sh || true
pkill -f production-revalidate-sanita-v2 2>/dev/null || true
sleep 3
pkill -9 -f production-revalidate-sanita-v2 2>/dev/null || true
cp -f /tmp/production-revalidate-sanita-v2.mjs /opt/leadsniper-revalidate/app/scripts/
cp -f /tmp/production-revalidate-sanita-v2.mjs /opt/leadsniper-green/scripts/ 2>/dev/null || true
cp -f /tmp/production-revalidate-sanita-v2.mjs /opt/leadsniper/scripts/ 2>/dev/null || true

cd /opt/leadsniper-revalidate/app
SHA=$(cat RELEASE_SHA)
export GIT_HEAD="$SHA"
export RELEASE_SHA="$SHA"
export DATABASE_URL="file:/opt/leadsniper-revalidate/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export REVALIDATE_CONCURRENCY=1
export REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export PDFTOPPM_PATH="$(command -v pdftoppm || true)"
export FRONTIER_DB_PATH=/opt/leadsniper-revalidate/data/revalidation/frontiers/boot.sqlite

# fix checkpoint sha only
python3 - <<'PY'
import json, pathlib, datetime
p=pathlib.Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
sha=open("/opt/leadsniper-revalidate/app/RELEASE_SHA").read().strip()
cp=json.load(p.open()) if p.exists() else {"version":2,"done":{},"order":[],"stats":{"processed":0,"hot":0,"pub":0,"review":0,"retry":0,"tech":0,"errors":0},"startedAt":datetime.datetime.now(datetime.UTC).isoformat()}
cp["testedCodeSha"]=sha
p.write_text(json.dumps(cp, indent=2))
print("done", len(cp.get("done") or {}))
PY

LOG="/opt/leadsniper-revalidate/logs/revalidate-$(date -u +%Y%m%dT%H%M%SZ).log"
nohup npx tsx scripts/production-revalidate-sanita-v2.mjs >>"$LOG" 2>&1 &
echo $! > /opt/leadsniper-revalidate/revalidate.pid
sleep 10
echo "STARTED pid=$(cat /opt/leadsniper-revalidate/revalidate.pid) sha=$SHA log=$LOG"
head -n 8 "$LOG"
free -m | head -2
pgrep -c -f chrome-headless-shell || echo chrome=0
