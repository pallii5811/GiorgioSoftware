#!/usr/bin/env python3
"""READ-ONLY: current 877 progress + why UI might show 13."""
import json, time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(CP.read_text())
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}
st = Counter(v.get("processingState") for v in term.values())
age = int(time.time() - CP.stat().st_mtime)

fins = []
for lid, v in term.items():
    fa = v.get("finishedAt")
    if fa:
        fins.append((fa, v.get("processingState"), lid))
fins.sort()

pub = sum(v for k, v in st.items() if str(k).startswith("PUBLISHED"))
print(json.dumps({
    "backend_not_ui": True,
    "checkpoint_age_sec": age,
    "updatedAt": cp.get("updatedAt"),
    "terminal": len(term),
    "by_state": dict(st.most_common()),
    "published_sum": pub,
    "hot": st.get("HOT_VERIFIED", 0),
    "review": st.get("REVIEW_HUMAN", 0),
    "retry_open": len(rq),
    "in_progress": len(inp),
    "pool_check": len(term) + len(rq) + len(set(inp) - set(term) - set(rq)),
    "last_5_terminals": [
        {"finishedAt": a, "state": b, "id": c} for a, b, c in fins[-5:]
    ],
    "minutes_since_last_terminal": (
        int((datetime.now(timezone.utc) - datetime.fromisoformat(fins[-1][0].replace("Z", "+00:00"))).total_seconds() // 60)
        if fins else None
    ),
    "stats": cp.get("stats"),
}, indent=2, ensure_ascii=False))
