#!/usr/bin/env bash
# Stop canary, redeploy OCR+frontier patches, restart ONLY Maione+Nuova Alba.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
STAGING=/tmp/stopship-ocr-fix
OUT=/tmp/stopship-ocr-diag
LOG=/opt/leadsniper-revalidate/logs/stopship-ocr-canary2.log
IDS="cmqkld5s700a8108eti0nofjv,cmql46eia000ac9w78xh0rxdl"

mkdir -p "$OUT" "$STAGING/src/lib/sanita" "$STAGING/scripts" "$STAGING/scripts/systemd"

echo "=== stop canary / orphans ==="
pkill -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
sleep 2
pkill -9 -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -9 -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
sleep 1
rm -f /opt/leadsniper-revalidate/data/revalidation/locks/*.lock
test "$(systemctl is-active giorgio-revalidate || true)" != "active"

echo "=== deploy patched sources ==="
bash /tmp/remote-stopship-ocr-deploy.sh

echo "=== prepare checkpoint for 2 leads ==="
python3 - <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path
cp_path=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
c=json.loads(cp_path.read_text())
ids=["cmqkld5s700a8108eti0nofjv","cmql46eia000ac9w78xh0rxdl"]
now=datetime.now(timezone.utc).isoformat()
rq=c.setdefault("retryQueue",{})
term=c.get("terminal") or {}
ip=c.get("inProgress") or {}
for lid in ids:
  if lid in term: del term[lid]
  if lid in ip: del ip[lid]
  meta=rq.get(lid) if isinstance(rq.get(lid), dict) else {}
  rq[lid]={**meta, "nextRetryAt": now, "operational": True, "canaryOcrAt": now}
c["terminal"]=term
c["retryQueue"]=rq
c["inProgress"]=ip
c["updatedAt"]=now
tmp=cp_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
tmp.replace(cp_path)
print("prepared", ids, "inProgress", list(ip.keys()))
PY

# frontier before snapshot
python3 - <<'PY'
import json, sqlite3
from pathlib import Path
paths={
 "maione":"/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite",
 "alba":"/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmql46eia000ac9w78xh0rxdl-1784579490121.sqlite",
}
out={}
for k,fp in paths.items():
  if not Path(fp).exists():
    out[k]={"missing":True}; continue
  c=sqlite3.connect(fp)
  by=dict(c.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall())
  run=c.execute("SELECT totalDiscovered,totalRelevant,totalCompleted,totalPending,totalFailed,stopReason,state FROM CrawlRun ORDER BY rowid DESC LIMIT 1").fetchone()
  out[k]={"byState":by,"run":list(run) if run else None,"path":fp}
  c.close()
Path("/tmp/stopship-ocr-diag/canary-frontier-before-v2.json").write_text(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
PY

cd "$APP"
export DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true
export TOTAL_WORKERS=1 REVALIDATE_CONCURRENCY=1 REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
export REVALIDATE_OUT_DIR=/opt/leadsniper-revalidate/data/revalidation
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CRAWL_HTML_URL_CAP=60 CRAWL_RUN_MAX_WALL_CLOCK_MS=3600000
export CRAWL_MAX_HTML_PER_SLICE=16 PER_HOST_CONCURRENCY=1
export REVALIDATE_LEAD_WALL_MS=3600000 REVALIDATE_RETRY_BASE_MS=30000
export REVALIDATE_IDS="$IDS"
export GIT_HEAD=$(cat RELEASE_SHA 2>/dev/null || echo fe8b677)
export RELEASE_SHA=$GIT_HEAD
export NODE_OPTIONS=--max-old-space-size=3072

npm run preflight:ocr | tee "$OUT/canary-preflight-v2.log"

: > "$LOG"
nohup /usr/bin/flock -n /opt/leadsniper-revalidate/revalidate.parent.lock \
  npx tsx scripts/production-revalidate-sanita-v3.mjs \
  >"$LOG" 2>&1 &
echo $! > "$OUT/canary2.pid"
sleep 4
head -40 "$LOG" || true
echo CANARY2_RESTARTED pid=$(cat "$OUT/canary2.pid")
