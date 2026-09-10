#!/usr/bin/env python3
import json, re
from pathlib import Path

ids = [
    "cmqklex5q00bh108eq9blm01k",
    "cmqktyimz000i111hygme29nh",
    "cmqkld5rk009b108ekvol7g87",
    "cmql4d399000uc9w7yzw2dgac",
    "cmql4qrif000yc9w74e0tmpqt",
    "cmqn40oou0002kwqdfi0ipn2g",
]
rd = Path("/opt/leadsniper-revalidate/data/revalidation/results")
out = []
for i in ids:
    row = json.load(open(rd / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    item = {
        "id": i,
        "company": row.get("companyName"),
        "city": row.get("city"),
        "processingState": row.get("processingState"),
        "token": row.get("token"),
        "businessVerdict": row.get("businessVerdict"),
        "reasonCode": row.get("reasonCode"),
        "wallMs": row.get("wallMs"),
        "policyFound": row.get("policyFound"),
        "error": row.get("error"),
        "STATE": re.findall(r"\[STATE:[^\]]+\]", ev)[:8],
        "BV": re.findall(r"\[BV:[^\]]+\]", ev)[:8],
        "V": re.findall(r"\[V:[^\]]+\]", ev)[:6],
        "VS": re.findall(r"\[VS:[^\]]+\]", ev)[:6],
        "CRAWL": re.findall(r"\[CRAWL_COMPLETE:[^\]]+\]", ev)[:4],
        "hits": [p for p in ["IDENTITY", "MISMATCH", "Contaminazione", "conflitto", "REVIEW", "OCR", "sito errato"] if re.search(p, ev, re.I)],
        "ev_tail": ev[-600:].replace("\n", " "),
    }
    out.append(item)
    print(json.dumps(item, ensure_ascii=False, indent=1))
    print()

Path("/opt/leadsniper-revalidate/data/k3-stopship/canary2-review-audit.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=2)
)
print("wrote canary2-review-audit.json")
