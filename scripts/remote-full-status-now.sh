#!/usr/bin/env bash
set -uo pipefail
echo "=== STUCK / WORKERS ==="
pgrep -af 'production-revalidate-sanita-worker' | head -20
ps -eo pid,etime,pcpu,pmem,cmd | grep -E 'production-revalidate-sanita-worker|chrome-headless' | grep -v grep | head -25
echo "=== LOCKS ==="
ls -la /opt/leadsniper-revalidate/data/revalidation/locks/ 2>/dev/null || true
echo "=== LAST 40 LOG ==="
tail -n 40 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000'
echo "=== RESULT REASONS (latest mtime) ==="
python3 - <<'PY'
import json, collections, os
from pathlib import Path
from datetime import datetime, timezone
rows=[]
for f in Path("/opt/leadsniper-revalidate/data/revalidation/results").glob("*.json"):
  try:
    row=json.loads(f.read_text())
    row["_mtime"]=f.stat().st_mtime
    rows.append(row)
  except: pass
rows.sort(key=lambda r: r["_mtime"], reverse=True)
print("n_results", len(rows))
# classify last 25 by evidence
def code(row):
  ev=(row.get("fullEvidence") or "") + " " + str(row.get("reasonCode") or "")
  ps=row.get("processingState")
  if ps and ps not in ("RETRY_PENDING", None) and ps != "RETRY_PENDING":
    return f"TERMINAL:{ps}"
  if "Contaminazione critica" in ev or "IDENTITY:MISMATCH" in ev: return "identity_mismatch"
  if "PDF non processati" in ev: return "pdf_unprocessed"
  if "sitemap" in ev.lower() or "ROBOTS_REFERENCED_FAILED" in ev or "DISCOVERED_FAILED" in ev: return "sitemap_unresolved"
  if "cap URL" in ev or "cap tempo" in ev or "coda HTML" in ev: return "frontier_or_cap"
  if "scadut" in ev.lower() and "[DOCS:" in ev: return "should_be_published_expired"
  if row.get("error"): return "worker_error:"+str(row.get("error"))[:40]
  return "other:"+str(row.get("reasonCode") or ps)
sample=rows[:25]
ctr=collections.Counter(code(r) for r in sample)
print("last25", dict(ctr))
for r in sample[:8]:
  print(json.dumps({
    "id": r.get("id"),
    "ps": r.get("processingState"),
    "rc": r.get("reasonCode"),
    "wall": r.get("wallMs") or (r.get("pass1") or {}).get("wallMs"),
    "code": code(r),
    "mtime": datetime.fromtimestamp(r["_mtime"], timezone.utc).isoformat(),
    "head": (r.get("fullEvidence") or "")[:140],
  }, ensure_ascii=False))
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
# wall of inProgress
for lid, meta in (cp.get("inProgress") or {}).items():
  started=meta.get("startedAt")
  print("INPROG", lid, "started", started, "run", meta.get("runId"))
# retry integrity
rq=cp.get("retryQueue") or {}
print("retry_integrity", {
  "n": len(rq),
  "missing_next": sum(1 for m in rq.values() if not m.get("nextRetryAt")),
  "missing_reason": sum(1 for m in rq.values() if not (m.get("lastReason") or m.get("lastError"))),
  "attempts_ge5": sum(1 for m in rq.values() if (m.get("attempts") or 0)>=5),
  "reasons": dict(collections.Counter(m.get("lastReason") for m in rq.values())),
})
# false HOT: HOT without pass2
false_hot=0
for r in rows:
  if r.get("processingState")=="HOT_VERIFIED" and not r.get("pass2"):
    false_hot += 1
print("false_hot_no_pass2", false_hot)
print("terminal_cp", {k:v.get("processingState") for k,v in (cp.get("terminal") or {}).items()})
PY
echo "=== BYTE MATCH ==="
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-v3.mjs /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs /opt/leadsniper-revalidate/app/src/lib/sanita/crawl-slice-runner.ts
echo "=== UNIT ==="
systemctl show giorgio-revalidate -p ActiveState -p SubState -p Environment --no-pager | head -5
grep -E 'TOTAL_WORKERS|flock|OUT_DIR|NODE_OPTIONS' /etc/systemd/system/giorgio-revalidate.service
free -h | head -2
