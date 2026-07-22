#!/usr/bin/env python3
import json, re
from pathlib import Path
ids = [
    "cmqklex5q00bh108eq9blm01k",
    "cmqktyimz000i111hygme29nh",
    "cmqkld5rk009b108ekvol7g87",
    "cmql4qrif000yc9w74e0tmpqt",
]
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for i in ids:
    row = json.load(open(rd / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    print("====", row.get("companyName"))
    for needle in [
        "PUBLISHED gate",
        "identità",
        "gate:",
        "prepareSanita",
        "needsOcr",
        "policyFound",
        "HOT gate",
        "Incomplete",
        "OCR",
        "obsolete",
        "autoassicur",
        "CONFLICT",
        "REVIEW_HUMAN",
    ]:
        m = re.search(r".{0,80}" + re.escape(needle) + r".{0,120}", ev, re.I)
        if m:
            print(" ", needle, "=>", m.group(0).replace("\n", " ")[:200])
    print(" head:", ev[:350].replace("\n", " "))
    print()
