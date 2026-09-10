#!/usr/bin/env bash
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

# ensure previous probe ended
pkill -f 'timeout 2400 npx tsx scripts/production-revalidate' 2>/dev/null || true
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
sleep 2

python3 - <<'PY'
import json
from pathlib import Path
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
ids=Path("/tmp/probe2-ids.txt").read_text().strip().split(",")
for i in ids:
  if i in (cp.get("terminal") or {}):
    continue
  meta=(cp.get("retryQueue") or {}).get(i) or {"attempts": cp.get("attempts",{}).get(i,1)}
  meta["nextRetryAt"]="1970-01-01T00:00:00.000Z"
  meta["lastReason"]=meta.get("lastReason") or "FORCED_PROBE"
  cp.setdefault("retryQueue",{})[i]=meta
# clear inProgress
cp["inProgress"]={}
p.write_text(json.dumps(cp, indent=2))
print("forced_due", ids)
print("retry", len(cp.get("retryQueue") or {}))
PY

rm -f "$DATA/locks"/*.lock 2>/dev/null || true

cd "$APP"
export GIT_HEAD=$(cat RELEASE_SHA) RELEASE_SHA=$(cat RELEASE_SHA)
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true
export TOTAL_WORKERS=1 REVALIDATE_CONCURRENCY=1 REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=$DATA/checkpoint.json
export REVALIDATE_OUT_DIR=$DATA
export TESSDATA_PREFIX=$APP/.tesseract-cache
export PDFTOPPM_PATH=$(command -v pdftoppm)
export CRAWL_HTML_URL_CAP=40
export CRAWL_RUN_MAX_WALL_CLOCK_MS=1500000
export CRAWL_MAX_HTML_PER_SLICE=12
export PER_HOST_CONCURRENCY=1
export REVALIDATE_LEAD_WALL_MS=1500000
export NODE_OPTIONS=--max-old-space-size=3072
export REVALIDATE_IDS="$(cat /tmp/probe2-ids.txt)"
LOG=$WORKDIR/logs/probe-pdfprio2-$(date -u +%Y%m%dT%H%M%SZ).log
echo "starting ids=$REVALIDATE_IDS log=$LOG"
timeout 2400 npx tsx scripts/production-revalidate-sanita-v3.mjs >"$LOG" 2>&1 || echo "probe_exit=$?"
tail -n 80 "$LOG" | tr -d '\000'
python3 - <<'PY'
import json, sqlite3, glob
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
ids=Path("/tmp/probe2-ids.txt").read_text().strip().split(",")
print("PROBE2_RESULTS")
for i in ids:
  t=(cp.get("terminal") or {}).get(i)
  r=(cp.get("retryQueue") or {}).get(i)
  row=None
  p=Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{i}.json")
  if p.exists():
    try: row=json.loads(p.read_text())
    except: pass
  fps=sorted(glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{i}*.sqlite"), key=lambda x: Path(x).stat().st_mtime, reverse=True)
  pdf_states={}
  if fps:
    try:
      c=sqlite3.connect(f"file:{fps[0]}?mode=ro", uri=True)
      pdf_states=dict(c.execute("select state, count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
      html_done=c.execute("select count(*) from CrawlFrontierNode where resourceType='html' and state='COMPLETED'").fetchone()[0]
      c.close()
    except Exception as e:
      pdf_states={"err":str(e)}; html_done=None
  else:
    html_done=None
  print(json.dumps({
    "id": i,
    "terminal": t,
    "retry": {k:r.get(k) for k in ("attempts","lastReason","lastError","nextRetryAt")} if r else None,
    "result_state": (row or {}).get("processingState"),
    "reasonCode": (row or {}).get("reasonCode"),
    "pdf_states": pdf_states,
    "html_completed": html_done,
    "evidence_head": ((row or {}).get("fullEvidence") or "")[:260],
  }, ensure_ascii=False))
print(json.dumps({"terminal_total": len(cp.get("terminal") or {}), "retry_total": len(cp.get("retryQueue") or {})}))
PY

echo "=== RESUME @2 ==="
rm -f "$DATA/locks"/*.lock 2>/dev/null || true
# force all interrupted/due retries keep backoff except leave queue as-is
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 8
systemctl is-active giorgio-revalidate
tail -n 20 $WORKDIR/logs/systemd-revalidate.log | tr -d '\000' | tail -n 20
