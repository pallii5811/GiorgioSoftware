#!/usr/bin/env bash
set -euo pipefail
OUT=/opt/leadsniper-revalidate/data/revalidation-published-priority
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "PID=$(cat $OUT/priority-batch.pid 2>/dev/null || true)"
if [ -f "$OUT/priority-batch.pid" ]; then
  pid=$(cat "$OUT/priority-batch.pid")
  if kill -0 "$pid" 2>/dev/null; then echo "BATCH=running"; else echo "BATCH=stopped"; fi
fi
python3 <<'PY'
import json,os,sqlite3
from collections import Counter
out="/opt/leadsniper-revalidate/data/revalidation-published-priority"
q=json.load(open(f"{out}/priority-queue.json"))
print("QUEUE", q.get("queueCount"), "REJECTED", q.get("rejectedCount"))
# live PUB count
con=sqlite3.connect("file:/opt/leadsniper/prisma/dev.db?mode=ro", uri=True)
cur=con.execute("SELECT evidence, policyFound FROM Lead WHERE type='HEALTHCARE'")
pub=0
pf=0
for ev,p in cur:
  e=ev or ""
  if e.startswith("[V:PUB]") or "[BV:PUBLISHED_" in e.upper() or "[STATE:PUBLISHED_" in e.upper():
    pub+=1
  if p: pf+=1
print("LIVE_PUB_TOKENISH", pub, "LIVE_POLICYFOUND", pf)
cp_path=f"{out}/checkpoint.json"
if os.path.exists(cp_path):
  cp=json.load(open(cp_path))
  print("TERM", len(cp.get("terminal") or {}), "RETRY", len(cp.get("retryQueue") or {}), "INPROG", len(cp.get("inProgress") or {}))
  print("STATS", json.dumps(cp.get("stats")))
  c=Counter(v.get("processingState") for v in (cp.get("terminal") or {}).values())
  print("TERM_STATES", dict(c))
else:
  print("NO_CP_YET")
res=f"{out}/results"
n=0
states=Counter()
if os.path.isdir(res):
  for f in os.listdir(res):
    if f.endswith(".json") and ".p1." not in f:
      n+=1
      try:
        r=json.load(open(os.path.join(res,f)))
        states[r.get("processingState")]+=1
      except Exception:
        pass
print("RESULTS", n, dict(states))
if os.path.exists(f"{out}/priority-report.json"):
  print("REPORT", open(f"{out}/priority-report.json").read()[:1500])
# tail log
log=f"{out}/priority-batch.log"
if os.path.exists(log):
  lines=open(log,errors="replace").read().splitlines()[-15:]
  print("LOG_TAIL")
  for L in lines: print(L)
PY
