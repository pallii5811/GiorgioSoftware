#!/usr/bin/env python3
import json, re
from pathlib import Path
ids = [
    "cmqklex5q00bh108eq9blm01k",
    "cmqktyimz000i111hygme29nh",
    "cmqkld5rk009b108ekvol7g87",
    "cmql4d399000uc9w7yzw2dgac",
    "cmql4qrif000yc9w74e0tmpqt",
]
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for i in ids:
    row = json.load(open(rd / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    m = re.search(r"PUBLISHED gate: ([^.]+)", ev)
    print(row.get("companyName"), row.get("processingState"), row.get("wallMs"), row.get("finishedAt"))
    print("  gate:", m.group(1) if m else "NO_PUB_GATE")
    print("  head:", ev[:220].replace("\n", " "))
    print()

# verify deployed RC-08 marker
ef = Path("/opt/leadsniper-revalidate/app/src/lib/sanita/entity-fingerprint.ts").read_text()
print("RC-08 in entity-fingerprint:", "RC-08" in ef, "firstPartyPolicyDoc" in ef)
ce = Path("/opt/leadsniper-revalidate/app/src/lib/sanita/can-emit-published.ts").read_text()
print("RC-08b in can-emit:", "RC-08b" in ce, "posizione" in ce)
