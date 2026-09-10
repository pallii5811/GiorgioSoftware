#!/usr/bin/env python3
import json, re
from pathlib import Path
ids = ["cmqkld5rk009b108ekvol7g87", "cmql4qrif000yc9w74e0tmpqt", "cmql4d399000uc9w7yzw2dgac"]
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for i in ids:
    row = json.load(open(rd / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    m = re.search(r"PUBLISHED gate: ([^.]{0,160})", ev)
    print("====", row.get("companyName"), "|", row.get("processingState"), "| wall", row.get("wallMs"))
    print("  gate:", m.group(1) if m else "NO_PUB_GATE")
    print("  head:", ev[:300].replace("\n", " "))
    print()
