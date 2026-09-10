#!/usr/bin/env bash
# Start published-priority batch on Hetzner (separate OUT_DIR). Does NOT start giorgio-revalidate.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
OUT=/opt/leadsniper-revalidate/data/revalidation-published-priority
SHADOW=file:/opt/leadsniper-revalidate/shadow-revalidate.db
LIVE_DB=/opt/leadsniper/prisma/dev.db
META=/opt/leadsniper/backups/giorgio-live-20260720T165135Z.meta.json

echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
test "$(systemctl is-active giorgio-revalidate || true)" != "active" || {
  echo "REFUSING: general revalidate still active — stop gracefully first"
  exit 2
}

mkdir -p "$OUT"
cd "$APP"

# Build queue from LIVE (read-only)
LIVE_DB="$LIVE_DB" OUT="$OUT/priority-queue.json" npx tsx scripts/build-published-priority-queue.mjs

# Sync worker + scripts if present in staging dir
if [ -d /tmp/published-priority-deploy ]; then
  cp -a /tmp/published-priority-deploy/scripts/*.mjs "$APP/scripts/" 2>/dev/null || true
fi

export DATABASE_URL="$SHADOW"
export DISABLE_LIVE_DB=true
export REVALIDATE_OUT_DIR="$OUT"
export QUEUE_JSON="$OUT/priority-queue.json"
export TOTAL_WORKERS=3
export MAX_OCR=2
export MAX_PLAYWRIGHT=2
export AUTO_APPLY_CERTIFIED=0
export APPLY_LIVE=0
export BACKUP_META_PATH="$META"
export LIVE_DATABASE_URL="file:$LIVE_DB"
export OCR_ENABLED=1
export SCAN_FAST=0
export GIT_HEAD="$(cat "$APP/RELEASE_SHA" 2>/dev/null || cat /opt/leadsniper/RELEASE_SHA)"
export RELEASE_SHA="$GIT_HEAD"
export NODE_OPTIONS="--max-old-space-size=3072"

nohup npx tsx scripts/production-revalidate-published-priority.mjs \
  >"$OUT/priority-batch.log" 2>&1 &
echo $! >"$OUT/priority-batch.pid"
echo "STARTED_PID=$(cat "$OUT/priority-batch.pid")"
sleep 3
head -40 "$OUT/priority-batch.log" || true
python3 - <<'PY'
import json
q=json.load(open("/opt/leadsniper-revalidate/data/revalidation-published-priority/priority-queue.json"))
print(json.dumps({"queueCount": q.get("queueCount"), "rejectedCount": q.get("rejectedCount")}, indent=2))
PY
echo "PRIORITY_BATCH_LAUNCHED"
