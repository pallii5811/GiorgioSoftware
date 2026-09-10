#!/usr/bin/env python3
import csv, json, os, sqlite3, re
from collections import Counter

CSV = "/opt/leadsniper-revalidate/app/docs/human-review/published-baseline-final/published-baseline.csv"
CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
# 877 pool: how is it defined? check job file or parent env
JOB = "/opt/leadsniper/data/sanita-revalidation-job.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"

pub=set()
with open(CSV, newline="", encoding="utf-8", errors="replace") as f:
    for row in csv.DictReader(f):
        if (row.get("verdict_storico") or "").upper()=="PUBLISHED" and row.get("leadId"):
            pub.add(row["leadId"])

cp=json.load(open(CP))
all_touched=set(cp.get("terminal") or {})|set(cp.get("retryQueue") or {})|set(cp.get("inProgress") or {})
# also any result files
for fn in os.listdir(RES):
    if fn.endswith(".json") and not fn.endswith(".p1.json") and not fn.endswith(".p2.json"):
        all_touched.add(fn.replace(".json",""))

inter = pub & all_touched
print(json.dumps({
  "published_baseline_n": len(pub),
  "touched_in_877_run": len(all_touched),
  "intersection": len(inter),
  "intersection_ids": sorted(inter),
  "intersection_detail": {
    lid: (
      (cp.get("terminal") or {}).get(lid)
      or (cp.get("retryQueue") or {}).get(lid)
      or (cp.get("inProgress") or {}).get(lid)
      or "result_only"
    )
    for lid in sorted(inter)
  },
}, indent=2, default=str))

# live sha stable?
import hashlib
print("LIVE_SHA", hashlib.sha256(open("/opt/leadsniper/prisma/dev.db","rb").read()).hexdigest())
