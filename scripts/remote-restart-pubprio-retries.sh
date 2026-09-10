#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
OUT=/opt/leadsniper-revalidate/data/revalidation-published-priority
cd "$APP"
export DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
export DISABLE_LIVE_DB=true
export REVALIDATE_OUT_DIR="$OUT"
export QUEUE_JSON="$OUT/priority-queue.json"
export TOTAL_WORKERS=3
export MAX_OCR=2
export AUTO_APPLY_CERTIFIED=0
export APPLY_LIVE=0
export BACKUP_META_PATH=/opt/leadsniper/backups/giorgio-live-20260720T165135Z.meta.json
export LIVE_DATABASE_URL=file:/opt/leadsniper/prisma/dev.db
export OCR_ENABLED=1
export SCAN_FAST=0
export GIT_HEAD=$(cat "$APP/RELEASE_SHA" 2>/dev/null || cat /opt/leadsniper/RELEASE_SHA)
export RELEASE_SHA=$GIT_HEAD
export NODE_OPTIONS=--max-old-space-size=3072
# Advance retries to due now
python3 - <<'PY'
import json, time
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation-published-priority/checkpoint.json"))
now=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
for k,v in (cp.get("retryQueue") or {}).items():
  if isinstance(v, dict):
    v["nextRetryAt"]=now
open("/opt/leadsniper-revalidate/data/revalidation-published-priority/checkpoint.json","w").write(json.dumps(cp,indent=2))
print("retry_due", len(cp.get("retryQueue") or {}))
PY
nohup npx tsx scripts/production-revalidate-published-priority.mjs >>"$OUT/priority-batch.log" 2>&1 &
echo $! >"$OUT/priority-batch.pid"
echo "RESTARTED=$(cat $OUT/priority-batch.pid)"
sleep 3
bash /tmp/remote-pubprio-status.sh | head -25
