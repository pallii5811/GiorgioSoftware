#!/usr/bin/env python3
import json, re
from pathlib import Path
ids = ["cmqkld5rk009b108ekvol7g87", "cmql4qrif000yc9w74e0tmpqt", "cmql4d399000uc9w7yzw2dgac"]
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for i in ids:
    row = json.load(open(rd / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    m = re.search(r"PUBLISHED gate: ([^\[]{0,300})", ev)
    print("====", row.get("companyName"), "|", row.get("processingState"), "| wall", row.get("wallMs"))
    print("  gate:", (m.group(1).strip() if m else "NO_PUB_GATE")[:280])
    print("  finishedAt", row.get("finishedAt"))
    print("  policyFound", row.get("policyFound"), "website", row.get("website"))
    print()
vg = open("/opt/leadsniper-revalidate/app/src/lib/sanita/verdict-gateway.ts").read()
print("attributionDetail deployed:", "attributionDetail" in vg)
ce = open("/opt/leadsniper-revalidate/app/src/lib/sanita/can-emit-published.ts").read()
print("attributionDetail in can-emit:", "attributionDetail" in ce)
