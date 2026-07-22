#!/usr/bin/env python3
import json, re
from pathlib import Path

row = json.load(open("/opt/leadsniper-revalidate/data/revalidation/results/cmqklex5q00bh108eq9blm01k.json"))
ev = row.get("fullEvidence") or ""
print(json.dumps({
    "company": row.get("companyName"),
    "processingState": row.get("processingState"),
    "businessVerdict": row.get("businessVerdict"),
    "token": row.get("token"),
    "policyFound": row.get("policyFound"),
    "policyCompany": row.get("policyCompany"),
    "policyExpiry": row.get("policyExpiry"),
    "wallMs": row.get("wallMs"),
    "error": row.get("error"),
    "terminal": row.get("terminal"),
    "frontierPaths": row.get("frontierPaths"),
    "STATE": re.findall(r"\[STATE:[^\]]+\]", ev)[:4],
    "BV": re.findall(r"\[BV:[^\]]+\]", ev)[:4],
    "V": re.findall(r"\[V:[^\]]+\]", ev)[:4],
    "DOCS": re.findall(r"\[DOCS: [^\]]+\]", ev)[:2],
}, ensure_ascii=False, indent=1))
print("ev_head:", ev[:500].replace("\n", " "))
# demotion state of remaining 4
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
for i in ["cmqktyimz000i111hygme29nh","cmqkld5rk009b108ekvol7g87","cmql4d399000uc9w7yzw2dgac","cmql4qrif000yc9w74e0tmpqt"]:
    t = cp.get("terminal", {}).get(i)
    r = cp.get("retryQueue", {}).get(i)
    print(i, "terminal" if t else ("retry:" + str((r or {}).get("lastError"))) if r else "MISSING",
          (t or {}).get("processingState") or "", (t or {}).get("finishedAt") or "")
