#!/usr/bin/env python3
import json, re
row = json.load(open("/opt/leadsniper-revalidate/data/revalidation/results/cmqp7cqya00011q5bkqf3ox8q.json"))
ev = row.get("fullEvidence") or ""
print(json.dumps({
  "state": row.get("processingState"),
  "reason": row.get("reasonCode"),
  "wall": row.get("wallMs"),
  "finishedAt": row.get("finishedAt"),
  "policyFound": row.get("policyFound"),
  "crawlComplete": row.get("crawlComplete"),
  "website": row.get("website"),
  "FRONTIER": re.findall(r"\[FRONTIER:[^\]]+\]", ev)[:2],
  "CRAWL": re.findall(r"\[CRAWL_COMPLETE:[^\]]+\]", ev)[:2],
  "STATE": re.findall(r"\[STATE:[^\]]+\]", ev)[:3],
}, ensure_ascii=False, indent=1))
print("tail:", ev[-400:].replace("\n", " "))

# full canary 10 score
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
ids = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(",")
strict = {"PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN", "SELF_INSURANCE_VERIFIED", "HOT_VERIFIED"}
comm = strict  # ANALOGOUS escluso
print("--- SCORE ---")
for i in ids:
  t = cp.get("terminal", {}).get(i)
  r = cp.get("retryQueue", {}).get(i)
  st = (t or {}).get("processingState") or (r or {}).get("lastReason")
  print(i[:12], st, "T" if t else "R")
print("strict", sum(1 for i in ids if (cp.get("terminal", {}).get(i) or {}).get("processingState") in strict))
print("withAnalogous", sum(1 for i in ids if (cp.get("terminal", {}).get(i) or {}).get("processingState") in comm))
