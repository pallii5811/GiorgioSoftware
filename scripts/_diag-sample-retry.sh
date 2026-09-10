#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, sqlite3
from pathlib import Path
from collections import Counter

S = Path("/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json")
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RESULTS = [
  Path("/opt/leadsniper-revalidate/data/revalidation/results"),
  Path("/opt/leadsniper-revalidate/app/data/revalidation/results"),
]
s = json.loads(S.read_text())
cp = json.loads(CP.read_text())
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
ip = cp.get("inProgress") or {}

def find_result(lid):
  for d in RESULTS:
    for name in (f"{lid}.json", f"{lid}.p1.json", f"{lid}.p2.json"):
      p = d / name
      if p.exists():
        try:
          return p, json.loads(p.read_text())
        except Exception as e:
          return p, {"_err": str(e)}
  return None, None

print("=== SAMPLE DETAIL ===")
for r in s["records"]:
  lid = r["leadId"]
  st = "TERM" if lid in term else ("IP" if lid in ip else ("RQ" if lid in rq else "MISS"))
  meta = rq.get(lid) or term.get(lid) or ip.get(lid) or {}
  p, row = find_result(lid)
  reason = None
  pstate = None
  wall = None
  if row:
    reason = row.get("reasonCode") or row.get("error") or row.get("lastError")
    pstate = row.get("processingState") or row.get("businessVerdict")
    wall = row.get("wallMs") or row.get("durationMs")
  fp = meta.get("frontierPath") or r.get("frontierPath")
  pending = urlcap = state = None
  if fp and Path(fp).exists():
    try:
      con = sqlite3.connect(f"file:{fp}?mode=ro", uri=True)
      cur = con.cursor()
      # try common schemas
      cols = [c[1] for c in cur.execute("PRAGMA table_info(nodes)").fetchall()] if cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").fetchone() else []
      if cols:
        pending = cur.execute("SELECT COUNT(*) FROM nodes WHERE status IN ('PENDING','QUEUED','OPEN') OR state IN ('PENDING','QUEUED','OPEN')").fetchone()
        # softer
        try:
          pending = cur.execute("SELECT COUNT(*) FROM nodes WHERE COALESCE(completed,0)=0 AND COALESCE(status,'') NOT IN ('DONE','COMPLETED','SKIPPED','FAILED')").fetchone()[0]
        except Exception:
          pending = cur.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
      meta_row = None
      if cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
        meta_row = dict(cur.execute("SELECT key,value FROM meta").fetchall())
      elif cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='run'").fetchone():
        meta_row = dict(cur.execute("SELECT * FROM run").fetchone() or {})
      con.close()
      state = (meta_row or {}).get("state") or (meta_row or {}).get("status")
      urlcap = (meta_row or {}).get("urlCapReached") or (meta_row or {}).get("url_cap_reached")
    except Exception as e:
      pending = f"err:{e}"
  print(json.dumps({
    "id": lid,
    "name": (r.get("companyName") or "")[:50],
    "initErr": r.get("initialError"),
    "st": st,
    "attempts": (rq.get(lid) or {}).get("attempts") or meta.get("attempts"),
    "lastError": (rq.get(lid) or {}).get("lastError") or (rq.get(lid) or {}).get("lastReason"),
    "strategy": (rq.get(lid) or {}).get("strategy") or (ip.get(lid) or {}).get("strategy"),
    "resultState": pstate,
    "resultReason": reason,
    "wall": wall,
    "frontierPending": pending,
    "frontierState": state,
    "resultPath": str(p) if p else None,
  }, ensure_ascii=False))

print("=== PROCESS TREE ===")
PY
pstree -ap $(systemctl show -p MainPID --value giorgio-revalidate) 2>/dev/null | head -n 40 || ps --forest -g $(systemctl show -p MainPID --value giorgio-revalidate) -o pid,pcpu,pmem,etime,cmd | head -n 40
echo "=== RECENT ERRORS ==="
grep -E 'lead_done|ANALYZE|reasonCode|error' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -n 40
