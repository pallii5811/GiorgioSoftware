#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
rq = cp.get("retryQueue") or {}
now = datetime.now(timezone.utc)
due = []
parked = []
for lid, m in rq.items():
    t = m.get("nextRetryAt") or "1970"
    try:
        nt = datetime.fromisoformat(t.replace("Z", "+00:00"))
    except Exception:
        nt = now
    row = {"id": lid, "attempts": m.get("attempts"), "reason": m.get("lastReason"), "next": t}
    if nt <= now:
        due.append(row)
    if m.get("parkReason"):
        parked.append({**row, "parkReason": m.get("parkReason")})

print(
    json.dumps(
        {
            "terminal": len(cp.get("terminal") or {}),
            "retry": len(rq),
            "due_count": len(due),
            "due": due,
            "parked": parked,
            "inProgress": cp.get("inProgress") or {},
            "updatedAt": cp.get("updatedAt"),
        },
        indent=2,
    )
)
