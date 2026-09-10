#!/usr/bin/env bash
python3 <<'PY'
import json, urllib.request, sqlite3, subprocess
j=json.load(urllib.request.urlopen("http://127.0.0.1:3000/api/sanita?includePending=1", timeout=30))
print("actionable", j["meta"]["actionableCount"], "returned", len(j["data"]))
from collections import Counter
c=Counter()
for x in j["data"]:
  ps=(x.get("semantic") or {}).get("processingState") or "?"
  c[ps]+=1
print("commercial_states", dict(c))
con=sqlite3.connect("/opt/leadsniper/prisma/dev.db")
row=con.execute(
  "SELECT id,companyName,status,notes FROM Lead WHERE id=?",
  ("cmql4d38u000kc9w7ng9zvakw",),
).fetchone()
print("crm_sample", row)
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("general_cp", {
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
  "stats": cp.get("stats"),
})
print("reval", subprocess.check_output(["systemctl","is-active","giorgio-revalidate"], text=True).strip())
prio=json.load(open("/opt/leadsniper-revalidate/data/revalidation-published-priority/priority-report.json"))
print("prio_summary", {k:prio.get(k) for k in ["queueCount","certified","current","expired","dateUnknown","retry","review","dryRunOk","elapsedMs","throughputPerHour"]})
PY
