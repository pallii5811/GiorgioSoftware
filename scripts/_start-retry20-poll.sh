#!/usr/bin/env bash
set -euo pipefail
nohup env GATE_TIMEOUT_S=2400 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo POLL_PID=$!
sleep 2
head -8 /tmp/retry20-gate.log || true
echo REVAL_PID=$(systemctl show -p MainPID --value giorgio-revalidate)
systemctl is-active giorgio-revalidate
# Expand sample to 20 if only 18
python3 <<'PY'
import json, os
from datetime import datetime, timezone
SAMPLE="/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json"
CP="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES="/opt/leadsniper-revalidate/data/revalidation/results"
s=json.load(open(SAMPLE))
cp=json.load(open(CP))
ids=[r["leadId"] for r in s["records"]]
print("sample_now", len(ids))
if len(ids)>=20:
    raise SystemExit(0)
term=set((cp.get("terminal") or {}).keys())
rq=cp.get("retryQueue") or {}
now0="1970-01-01T00:00:00.000Z"
files=[]
for name in os.listdir(RES):
    if name.endswith(".json") and not name.endswith((".p1.json",".p2.json")):
        files.append((os.path.getmtime(os.path.join(RES,name)), name[:-5]))
files.sort(reverse=True)
added=0
for _,lid in files:
    if lid in ids or lid in term: continue
    row=json.load(open(os.path.join(RES,f"{lid}.json")))
    if row.get("processingState")!="RETRY_PENDING": continue
    ids.append(lid)
    s["records"].append({
        "leadId":lid,
        "companyName":row.get("companyName"),
        "initialError":row.get("reasonCode") or "RETRY_PENDING",
        "attempts":0,
        "frontierPath":(row.get("pass1") or {}).get("frontierPath"),
        "lastRunId":(row.get("pass1") or {}).get("runId"),
        "initialCompletedNodes":None,
    })
    if lid not in rq:
        rq[lid]={
            "attempts":1,
            "lastReason":row.get("reasonCode") or "RETRY_PENDING",
            "lastError":row.get("reasonCode") or "RETRY_PENDING",
            "nextRetryAt":now0,
            "lastRunId":(row.get("pass1") or {}).get("runId"),
            "frontierPath":(row.get("pass1") or {}).get("frontierPath"),
            "firstSeenAt":row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
            "lastAttemptAt":row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
            "operational":True,
        }
    else:
        rq[lid]["nextRetryAt"]=now0
    added+=1
    if len(ids)>=20: break
s["sampleSize"]=len(ids)
s["records"]=s["records"][:20]
cp["retryQueue"]=rq
cp["updatedAt"]=datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
tmp=CP+".tmp"
json.dump(cp, open(tmp,"w"), ensure_ascii=False, indent=2)
os.replace(tmp, CP)
json.dump(s, open(SAMPLE,"w"), ensure_ascii=False, indent=2)
print("expanded", added, "sample", len(s["records"]))
PY
