#!/usr/bin/env bash
# Graceful stop → tessdata fix → deploy PDF-drain + throughput patches → probe 5 leads → resume
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app

echo "=== GRACEFUL STOP ==="
systemctl stop giorgio-revalidate || true
for i in $(seq 1 120); do
  if ! pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then break; fi
  sleep 5
done
pgrep -af 'production-revalidate-sanita' || echo "stopped"

echo "=== TESSDATA ==="
TD=$APP/.tesseract-cache
mkdir -p "$TD"
# silence missing sidecar lookups used by some tesseract.js builds
: > "$TD/ita.special-words"
: > "$TD/eng.special-words"
: > "$TD/ita.user-words"
: > "$TD/eng.user-words"
ls -la "$TD"

echo "=== DEPLOY PATCHES ==="
cp -f /tmp/production-revalidate-sanita-v3.mjs $APP/scripts/
cp -f /tmp/production-revalidate-sanita-worker.mjs $APP/scripts/
cp -f /tmp/revalidate-checkpoint-v3.mjs $APP/scripts/
cp -f /tmp/crawl-slice-runner.ts $APP/src/lib/sanita/crawl-slice-runner.ts
# also blue tree for consistency (no restart of UI required for reval)
cp -f /tmp/crawl-slice-runner.ts /opt/leadsniper/src/lib/sanita/crawl-slice-runner.ts 2>/dev/null || true

# preserve checkpoint — only clear stale inProgress into retry on next parent start
python3 - <<'PY'
import json
from pathlib import Path
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
print(json.dumps({
  "version": cp.get("version"),
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress_before_clear": len(cp.get("inProgress") or {}),
}, indent=2))
# move inProgress to retry due now (parent also does this)
from datetime import datetime, timezone
now=datetime.now(timezone.utc).isoformat()
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "graceful_stop_for_patch",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId"),
      "frontierPath": (meta or {}).get("frontierPath"),
      "firstSeenAt": (meta or {}).get("startedAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
p.write_text(json.dumps(cp, indent=2))
print("retry_after", len(cp.get("retryQueue") or {}))
# pick 5 probe ids from retry
ids=list((cp.get("retryQueue") or {}).keys())[:5]
Path("/tmp/probe-ids.txt").write_text(",".join(ids))
print("probe_ids", ids)
PY

# update systemd env for throughput (no secrets)
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
Environment=TOTAL_WORKERS=6
Environment=REVALIDATE_CONCURRENCY=2
Environment=REVALIDATE_DUAL_HOT=1
Environment=REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
Environment=TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
Environment=FRONTIER_DB_PATH=/opt/leadsniper-revalidate/data/revalidation/frontiers/boot.sqlite
Environment=PDFTOPPM_PATH=/usr/bin/pdftoppm
Environment=CRAWL_HTML_URL_CAP=40
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
Environment=CRAWL_MAX_HTML_PER_SLICE=12
Environment=PER_HOST_CONCURRENCY=1
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
MemoryMax=6G

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

echo "=== PROBE 5 LEADS (isolated) ==="
PROBE_IDS=$(cat /tmp/probe-ids.txt)
cd "$APP"
export GIT_HEAD=$(cat RELEASE_SHA)
export RELEASE_SHA=$GIT_HEAD
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export STAGING_MODE=true
export DISABLE_LIVE_DB=true
export DISABLE_EMAILS=true
export TOTAL_WORKERS=2
export REVALIDATE_CONCURRENCY=2
export REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=$WORKDIR/data/revalidation/checkpoint.json
export TESSDATA_PREFIX=$APP/.tesseract-cache
export PDFTOPPM_PATH=$(command -v pdftoppm)
export CRAWL_HTML_URL_CAP=40
export CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
export CRAWL_MAX_HTML_PER_SLICE=12
export PER_HOST_CONCURRENCY=1
export REVALIDATE_IDS="$PROBE_IDS"
export REVALIDATE_LEAD_WALL_MS=1200000
LOG=$WORKDIR/logs/probe-5-$(date -u +%Y%m%dT%H%M%SZ).log
# run until those 5 settle or timeout 90 min
timeout 5400 npx tsx scripts/production-revalidate-sanita-v3.mjs >"$LOG" 2>&1 || true
tail -n 40 "$LOG"
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
ids=Path("/tmp/probe-ids.txt").read_text().strip().split(",")
print("PROBE_RESULTS")
for i in ids:
  t=(cp.get("terminal") or {}).get(i)
  r=(cp.get("retryQueue") or {}).get(i)
  print(json.dumps({"id": i, "terminal": t, "retry": {k:r.get(k) for k in ("attempts","lastReason","nextRetryAt")} if r else None}))
print(json.dumps({"terminal_total": len(cp.get("terminal") or {}), "retry_total": len(cp.get("retryQueue") or {})}))
PY

echo "=== RESUME FULL ==="
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 10
systemctl is-active giorgio-revalidate
tail -n 20 $WORKDIR/logs/systemd-revalidate.log | tr -d '\000' | tail -n 20
