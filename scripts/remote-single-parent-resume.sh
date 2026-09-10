#!/usr/bin/env bash
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

echo "=== HARD SINGLE-PARENT STOP ==="
systemctl stop giorgio-revalidate || true
pkill -9 -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -9 -f 'chrome-headless-shell' 2>/dev/null || true
sleep 2
pgrep -af production-revalidate || echo stopped
rm -f "$DATA/locks"/*.lock 2>/dev/null || true
rm -f "$APP/data/revalidation/locks"/*.lock 2>/dev/null || true

echo "=== REBUILD TERMINAL FROM RESULTS (no wipe) ==="
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
TERM={"HOT_VERIFIED","PUBLISHED_CURRENT","PUBLISHED_EXPIRED","PUBLISHED_DATE_UNKNOWN","REVIEW_HUMAN","TECHNICAL_BLOCKED","OUT_OF_SCOPE"}
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
# keep existing terminal
terminal=dict(cp.get("terminal") or {})
retry=dict(cp.get("retryQueue") or {})
attempts=dict(cp.get("attempts") or {})
res=Path("/opt/leadsniper-revalidate/data/revalidation/results")
recovered=0
for f in res.glob("*.json"):
  try: row=json.loads(f.read_text())
  except: continue
  lid=row.get("id")
  if not lid: continue
  ps=row.get("processingState")
  # dual HOT must have pass2
  if ps=="HOT_VERIFIED" and not row.get("pass2"):
    continue
  if ps in TERM and row.get("terminal") is not False:
    if lid not in terminal:
      recovered += 1
    terminal[lid]={
      "finishedAt": row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
      "processingState": ps,
      "newVerdict": row.get("newVerdict"),
      "reasonCode": row.get("reasonCode") or ps,
    }
    retry.pop(lid, None)
  elif ps=="RETRY_PENDING" or row.get("error"):
    if lid not in terminal and lid not in retry:
      retry[lid]={
        "attempts": attempts.get(lid,1),
        "lastReason": ps or "RETRY_PENDING",
        "lastError": row.get("error") or row.get("reasonCode"),
        "nextRetryAt": "1970-01-01T00:00:00.000Z",
        "lastRunId": (row.get("runIds") or [None])[0],
        "frontierPath": (row.get("frontierPaths") or [None])[0],
        "firstSeenAt": row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
        "lastAttemptAt": row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
      }
cp["terminal"]=terminal
cp["retryQueue"]=retry
cp["inProgress"]={}
cp["version"]=3
# recount stats lightly
cp.setdefault("stats",{})
cp["stats"]["terminal"]=len(terminal)
cp["stats"]["hot"]=sum(1 for v in terminal.values() if v.get("processingState")=="HOT_VERIFIED")
cp["stats"]["pub"]=sum(1 for v in terminal.values() if str(v.get("processingState","")).startswith("PUBLISHED"))
cp["stats"]["tech"]=sum(1 for v in terminal.values() if v.get("processingState")=="TECHNICAL_BLOCKED")
cp["stats"]["review"]=sum(1 for v in terminal.values() if v.get("processingState")=="REVIEW_HUMAN")
p.write_text(json.dumps(cp, indent=2))
print(json.dumps({
  "recovered_new_terminals": recovered,
  "terminal": len(terminal),
  "retry": len(retry),
  "by_state": {k: sum(1 for v in terminal.values() if v.get("processingState")==k) for k in sorted({v.get("processingState") for v in terminal.values()})},
}, indent=2))
PY

echo "=== UNIT WITH FLOCK ==="
cat >/etc/systemd/system/giorgio-revalidate.service <<'UNIT'
[Unit]
Description=Giorgio Sanita shadow revalidation v3 (single parent via flock)
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
Environment=REVALIDATE_LEAD_WALL_MS=1800000
Environment=NODE_OPTIONS=--max-old-space-size=3072
TimeoutStopSec=1200
KillMode=mixed
KillSignal=SIGTERM
# flock -n: refuse second parent (prevents checkpoint races)
ExecStart=/usr/bin/flock -n /opt/leadsniper-revalidate/revalidate.parent.lock /bin/bash -c 'export GIT_HEAD=$(cat RELEASE_SHA); export RELEASE_SHA=$GIT_HEAD; exec npx tsx scripts/production-revalidate-sanita-v3.mjs'
Restart=on-failure
RestartSec=60
StandardOutput=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
StandardError=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
Nice=5
MemoryMax=7G

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 12
echo "active=$(systemctl is-active giorgio-revalidate)"
echo "parents=$(pgrep -c -f 'production-revalidate-sanita-v3.mjs' || echo 0)"
echo "workers=$(pgrep -c -f 'production-revalidate-sanita-worker.mjs' || echo 0)"
tail -n 40 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 40
python3 -c 'import json;cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print(json.dumps({"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"inProgress":len(cp.get("inProgress")or{})}))'
free -h | head -2
