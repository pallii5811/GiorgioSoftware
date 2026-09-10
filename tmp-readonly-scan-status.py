#!/usr/bin/env python3
"""READ-ONLY status of giorgio-revalidate / 877 run. No mutations."""
import json, os, time
from collections import Counter
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")

cp = json.loads(CP.read_text(encoding="utf-8"))
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}
stats = cp.get("stats") or {}
age = int(time.time() - CP.stat().st_mtime)

states = Counter(v.get("processingState") for v in term.values())
pub_states = {k: v for k, v in states.items() if str(k).startswith("PUBLISHED") or k == "SELF_INSURANCE_VERIFIED"}

reasons = Counter()
for v in rq.values():
    r = str(v.get("lastReason") or "?")
    if "IDENTITY" in r.upper():
        reasons["IDENTITY_*"] += 1
    elif "CRAWL_CAP" in r or r.startswith("CAP"):
        reasons["CRAWL_CAP"] += 1
    elif "PDF" in r.upper():
        reasons["PDF_*"] += 1
    elif "RETRY" in r.upper():
        reasons["RETRY_PENDING"] += 1
    else:
        reasons[r.split(":")[0][:50]] += 1

print(json.dumps({
    "checkpoint_age_sec": age,
    "updatedAt": cp.get("updatedAt"),
    "stats": stats,
    "terminal_n": len(term),
    "terminal_by_state": dict(states.most_common()),
    "published_family": {
        "PUBLISHED_CURRENT": states.get("PUBLISHED_CURRENT", 0),
        "PUBLISHED_DATE_UNKNOWN": states.get("PUBLISHED_DATE_UNKNOWN", 0),
        "PUBLISHED_EXPIRED": states.get("PUBLISHED_EXPIRED", 0),
        "SELF_INSURANCE_VERIFIED": states.get("SELF_INSURANCE_VERIFIED", 0),
        "sum_pub_si": (
            states.get("PUBLISHED_CURRENT", 0)
            + states.get("PUBLISHED_DATE_UNKNOWN", 0)
            + states.get("PUBLISHED_EXPIRED", 0)
            + states.get("SELF_INSURANCE_VERIFIED", 0)
        ),
    },
    "hot": states.get("HOT_VERIFIED", 0),
    "review": states.get("REVIEW_HUMAN", 0),
    "tech": states.get("TECHNICAL_BLOCKED", 0),
    "retry_n": len(rq),
    "retry_top_reasons": dict(reasons.most_common(12)),
    "inProgress_n": len(inp),
    "inProgress": {k: {
        "startedAt": v.get("startedAt"),
        "pass": v.get("pass"),
        "strategy": v.get("strategy"),
        "resumed": v.get("resumed"),
        "runId": v.get("runId"),
    } for k, v in list(inp.items())[:3]},
}, indent=2, ensure_ascii=False))
