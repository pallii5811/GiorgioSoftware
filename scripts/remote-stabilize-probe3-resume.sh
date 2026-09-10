#!/usr/bin/env bash
# Stop → clear locks → unify OUT_DIR → deploy heap/lock patches → probe 3 → resume @2
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

echo "=== GRACEFUL STOP ==="
systemctl stop giorgio-revalidate || true
for i in $(seq 1 90); do
  if ! pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then break; fi
  sleep 2
done
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 2
pgrep -af 'production-revalidate' || echo "stopped"

echo "=== PATH AUDIT ==="
echo "locks_app=$(ls "$APP/data/revalidation/locks" 2>/dev/null | wc -l)"
echo "locks_data=$(ls "$DATA/locks" 2>/dev/null | wc -l)"
echo "results_app=$(ls "$APP/data/revalidation/results" 2>/dev/null | wc -l)"
echo "results_data=$(ls "$DATA/results" 2>/dev/null | wc -l)"
echo "frontiers_app=$(ls "$APP/data/revalidation/frontiers" 2>/dev/null | wc -l)"
echo "frontiers_data=$(ls "$DATA/frontiers" 2>/dev/null | wc -l)"
if [ -L "$APP/data/revalidation" ]; then
  echo "app_revalidation_symlink=$(readlink -f "$APP/data/revalidation")"
elif [ -d "$APP/data/revalidation" ]; then
  echo "app_revalidation_is_directory"
fi

echo "=== MERGE RESULTS INTO DATA TREE (no wipe) ==="
mkdir -p "$DATA/results" "$DATA/frontiers" "$DATA/locks"
# copy newer/missing results from app tree into canonical data tree
if [ -d "$APP/data/revalidation/results" ]; then
  rsync -a --ignore-existing "$APP/data/revalidation/results/" "$DATA/results/" || true
fi
if [ -d "$APP/data/revalidation/frontiers" ]; then
  rsync -a --ignore-existing "$APP/data/revalidation/frontiers/" "$DATA/frontiers/" || true
fi

echo "=== CLEAR ORPHAN LOCKS ==="
rm -f "$APP/data/revalidation/locks"/*.lock 2>/dev/null || true
rm -f "$DATA/locks"/*.lock 2>/dev/null || true
echo "locks_cleared"

echo "=== DEPLOY PATCHES ==="
cp -f /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/"
cp -f /tmp/production-revalidate-sanita-worker.mjs "$APP/scripts/"
cp -f /tmp/crawl-slice-runner.ts "$APP/src/lib/sanita/crawl-slice-runner.ts"
cp -f /tmp/crawl-slice-runner.ts /opt/leadsniper/src/lib/sanita/crawl-slice-runner.ts 2>/dev/null || true
sha256sum "$APP/scripts/production-revalidate-sanita-v3.mjs" /tmp/production-revalidate-sanita-v3.mjs
sha256sum "$APP/src/lib/sanita/crawl-slice-runner.ts" /tmp/crawl-slice-runner.ts

echo "=== CHECKPOINT PRESERVE ==="
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "stabilize_after_oom_locks",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or (meta or {}).get("startedAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
p.write_text(json.dumps(cp, indent=2))
print(json.dumps({
  "version": cp.get("version"),
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
}, indent=2))
# probe: prefer retries that are not interrupted-only if possible
ids=[]
for lid, meta in (cp.get("retryQueue") or {}).items():
  if meta.get("lastReason") not in ("IN_PROGRESS_INTERRUPTED",):
    ids.append(lid)
  if len(ids)>=3: break
if len(ids)<3:
  for lid in (cp.get("retryQueue") or {}):
    if lid not in ids:
      ids.append(lid)
    if len(ids)>=3: break
Path("/tmp/probe3-ids.txt").write_text(",".join(ids))
print("probe3", ids)
PY

echo "=== UNIT @ concurrency 2 + heap ==="
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

echo "=== MEM ==="
free -h

echo "=== PROBE 3 (concurrency 1, 45min cap) ==="
PROBE_IDS=$(cat /tmp/probe3-ids.txt)
cd "$APP"
export GIT_HEAD=$(cat RELEASE_SHA)
export RELEASE_SHA=$GIT_HEAD
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true
export TOTAL_WORKERS=1 REVALIDATE_CONCURRENCY=1 REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=$DATA/checkpoint.json
export REVALIDATE_OUT_DIR=$DATA
export TESSDATA_PREFIX=$APP/.tesseract-cache
export PDFTOPPM_PATH=$(command -v pdftoppm)
export CRAWL_HTML_URL_CAP=40
export CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
export CRAWL_MAX_HTML_PER_SLICE=12
export PER_HOST_CONCURRENCY=1
export NODE_OPTIONS=--max-old-space-size=3072
export REVALIDATE_IDS="$PROBE_IDS"
LOG=$WORKDIR/logs/probe-3-$(date -u +%Y%m%dT%H%M%SZ).log
timeout 2700 npx tsx scripts/production-revalidate-sanita-v3.mjs >"$LOG" 2>&1 || echo "probe_exit=$?"
echo "=== PROBE TAIL ==="
tail -n 50 "$LOG" | tr -d '\000'
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
ids=Path("/tmp/probe3-ids.txt").read_text().strip().split(",")
print("PROBE3_RESULTS")
for i in ids:
  t=(cp.get("terminal") or {}).get(i)
  r=(cp.get("retryQueue") or {}).get(i)
  print(json.dumps({"id": i, "terminal": t, "retry": {k:r.get(k) for k in ("attempts","lastReason","lastError","nextRetryAt")} if r else None}))
print(json.dumps({"terminal_total": len(cp.get("terminal") or {}), "retry_total": len(cp.get("retryQueue") or {})}))
# false HOT without dual
false_hot=0
review_tech=0
res=Path("/opt/leadsniper-revalidate/data/revalidation/results")
for f in res.glob("*.json"):
  try: row=json.loads(f.read_text())
  except: continue
  if row.get("processingState")=="HOT_VERIFIED" and not (row.get("pass2") or {}).get("processingState"):
    # allow if dual disabled result shape has pass1 only but parent should have demoted
    if not row.get("pass2"):
      false_hot += 1
  if row.get("reasonCode")=="DUAL_HOT_DISAGREE":
    review_tech += 0  # semantic review ok
  if "TECHNICAL" in str(row.get("reasonCode") or "") and "false" in str(row).lower():
    pass
print(json.dumps({"suspect_hot_no_pass2": false_hot}))
PY

echo "=== RESUME FULL @2 ==="
rm -f "$DATA/locks"/*.lock 2>/dev/null || true
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 8
systemctl is-active giorgio-revalidate
tail -n 30 $WORKDIR/logs/systemd-revalidate.log | tr -d '\000' | tail -n 30
free -h
