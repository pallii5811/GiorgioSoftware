#!/usr/bin/env bash
# Stop probe/service → deploy PDF priority + worker → short probe 2 → resume @2
# Checkpoint preserved. No apply live. No queue open.
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

echo "=== STOP ALL REVAL ==="
systemctl stop giorgio-revalidate || true
# kill probe script tree
pkill -f 'remote-stabilize-probe3-resume' 2>/dev/null || true
pkill -f 'timeout 2700 npx tsx scripts/production-revalidate' 2>/dev/null || true
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 3
pgrep -af production-revalidate || echo stopped

echo "=== DEPLOY ==="
cp -f /tmp/crawl-slice-runner.ts "$APP/src/lib/sanita/crawl-slice-runner.ts"
cp -f /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/"
cp -f /tmp/production-revalidate-sanita-worker.mjs "$APP/scripts/"
cp -f /tmp/crawl-slice-runner.ts /opt/leadsniper/src/lib/sanita/crawl-slice-runner.ts 2>/dev/null || true
sha256sum "$APP/src/lib/sanita/crawl-slice-runner.ts" /tmp/crawl-slice-runner.ts
sha256sum "$APP/scripts/production-revalidate-sanita-worker.mjs" /tmp/production-revalidate-sanita-worker.mjs

rm -f "$DATA/locks"/*.lock 2>/dev/null || true
rm -f "$APP/data/revalidation/locks"/*.lock 2>/dev/null || true

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
      "lastError": "pdf_priority_patch",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
p.write_text(json.dumps(cp, indent=2))
# pick 2 leads that previously failed with PDF unprocessed
prefer=[]
for f in Path("/opt/leadsniper-revalidate/data/revalidation/results").glob("*.json"):
  try: row=json.loads(f.read_text())
  except: continue
  ev=row.get("fullEvidence") or ""
  lid=row.get("id")
  if lid in (cp.get("terminal") or {}): continue
  if "PDF non processati" in ev and "IDENTITY:MISMATCH" not in ev:
    prefer.append(lid)
ids=prefer[:2]
if len(ids)<2:
  ids += [k for k in (cp.get("retryQueue") or {}) if k not in ids][:2-len(ids)]
Path("/tmp/probe2-ids.txt").write_text(",".join(ids))
print(json.dumps({"terminal":len(cp.get("terminal") or {}),"retry":len(cp.get("retryQueue") or {}),"probe2":ids},indent=2))
PY

# ensure unit has OUT_DIR + heap + workers=2
systemctl daemon-reload

echo "=== PROBE 2 PDF-PRIORITY (wall 25min/lead, concurrency 1, 40min cap) ==="
PROBE_IDS=$(cat /tmp/probe2-ids.txt)
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
export REVALIDATE_IDS="$PROBE_IDS"
LOG=$WORKDIR/logs/probe-pdfprio-$(date -u +%Y%m%dT%H%M%SZ).log
timeout 2400 npx tsx scripts/production-revalidate-sanita-v3.mjs >"$LOG" 2>&1 || echo "probe_exit=$?"
echo "=== PROBE TAIL ==="
tail -n 60 "$LOG" | tr -d '\000'
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
  # latest frontier for id
  fps=sorted(glob.glob(f"/opt/leadsniper-revalidate/data/revalidation/frontiers/*{i}*.sqlite"), key=lambda x: Path(x).stat().st_mtime, reverse=True)
  pdf_states={}
  if fps:
    try:
      c=sqlite3.connect(f"file:{fps[0]}?mode=ro", uri=True)
      pdf_states=dict(c.execute("select state, count(*) from CrawlFrontierNode where resourceType='pdf' group by 1").fetchall())
      c.close()
    except Exception as e:
      pdf_states={"err":str(e)}
  print(json.dumps({
    "id": i,
    "terminal": t,
    "retry": {k:r.get(k) for k in ("attempts","lastReason","lastError","nextRetryAt")} if r else None,
    "result_state": (row or {}).get("processingState"),
    "reasonCode": (row or {}).get("reasonCode"),
    "wallMs": (row or {}).get("wallMs") or ((row or {}).get("pass1") or {}).get("wallMs"),
    "pdf_states": pdf_states,
    "evidence_head": ((row or {}).get("fullEvidence") or "")[:220],
  }, ensure_ascii=False))
print(json.dumps({"terminal_total": len(cp.get("terminal") or {}), "retry_total": len(cp.get("retryQueue") or {})}))
PY

echo "=== RESUME @2 ==="
rm -f "$DATA/locks"/*.lock 2>/dev/null || true
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 8
systemctl is-active giorgio-revalidate
tail -n 25 $WORKDIR/logs/systemd-revalidate.log | tr -d '\000' | tail -n 25
free -h
