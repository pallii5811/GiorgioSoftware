#!/usr/bin/env bash
# Stop parent, clear orphan locks, diagnose paths, stabilize concurrency (no wipe checkpoint).
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

echo "=== GRACEFUL STOP ==="
systemctl stop giorgio-revalidate || true
for i in $(seq 1 60); do
  if ! pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then break; fi
  sleep 2
done
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
sleep 2
pgrep -af 'production-revalidate' || echo "stopped"

echo "=== PATHS ==="
echo "locks_app=$(ls "$APP/data/revalidation/locks" 2>/dev/null | wc -l)"
echo "locks_data=$(ls "$DATA/locks" 2>/dev/null | wc -l)"
echo "results_app=$(ls "$APP/data/revalidation/results" 2>/dev/null | wc -l)"
echo "results_data=$(ls "$DATA/results" 2>/dev/null | wc -l)"
echo "frontiers_app=$(ls "$APP/data/revalidation/frontiers" 2>/dev/null | wc -l)"
echo "frontiers_data=$(ls "$DATA/frontiers" 2>/dev/null | wc -l)"
readlink -f "$APP/data/revalidation" 2>/dev/null || true
ls -la "$APP/data" 2>/dev/null | head -20
ls -la "$WORKDIR/data" 2>/dev/null | head -20

echo "=== CLEAR ORPHAN LOCKS (both trees) ==="
rm -f "$APP/data/revalidation/locks"/*.lock 2>/dev/null || true
rm -f "$DATA/locks"/*.lock 2>/dev/null || true
mkdir -p "$DATA/locks" "$APP/data/revalidation/locks"
echo "locks_cleared"

echo "=== CHECKPOINT PRESERVE ==="
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
# move inProgress -> retry due now; do NOT wipe terminal/retry
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "stabilize_after_oom",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or (meta or {}).get("startedAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
# Fix bogus epoch-only interrupted retries that lack concrete reason after real attempt
# (keep them due-now; do not delete)
p.write_text(json.dumps(cp, indent=2))
print(json.dumps({
  "version": cp.get("version"),
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
}, indent=2))
PY

echo "=== MEM / CHROME ==="
free -h
pgrep -c -f 'chrome-headless-shell|chromium' || echo chrome=0
# kill stale chrome older than 30m not needed if no reval parent
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 1
free -h

echo "=== UNIT (safe ramp, heap limit) ==="
cat >/etc/systemd/system/giorgio-revalidate.service <<'UNIT'
[Unit]
Description=Giorgio Sanita shadow revalidation v3 (isolated workers)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/leadsniper-revalidate/app
Environment=DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
Environment=SCAN_ENGINE_LOCAL=1
Environment=OCR_ENABLED=1
Environment=POLICY_EXHAUSTIVE=1
Environment=SCAN_FAST=0
Environment=STAGING_MODE=true
Environment=DISABLE_LIVE_DB=true
Environment=DISABLE_EMAILS=true
Environment=TOTAL_WORKERS=2
Environment=REVALIDATE_CONCURRENCY=2
Environment=REVALIDATE_DUAL_HOT=1
Environment=REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
Environment=REVALIDATE_OUT_DIR=/opt/leadsniper-revalidate/data/revalidation
Environment=TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
Environment=FRONTIER_DB_PATH=/opt/leadsniper-revalidate/data/revalidation/frontiers/boot.sqlite
Environment=PDFTOPPM_PATH=/usr/bin/pdftoppm
Environment=CRAWL_HTML_URL_CAP=40
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
Environment=CRAWL_MAX_HTML_PER_SLICE=12
Environment=PER_HOST_CONCURRENCY=1
Environment=NODE_OPTIONS=--max-old-space-size=3072
Environment=GIT_HEAD_FILE=/opt/leadsniper-revalidate/app/RELEASE_SHA
TimeoutStopSec=1200
KillMode=mixed
KillSignal=SIGTERM
ExecStart=/bin/bash -c 'export GIT_HEAD=$(cat RELEASE_SHA); export RELEASE_SHA=$GIT_HEAD; exec npx tsx scripts/production-revalidate-sanita-v3.mjs'
Restart=on-failure
RestartSec=30
StandardOutput=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
StandardError=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
Nice=5
MemoryMax=7G

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "unit_updated_not_started_yet"
