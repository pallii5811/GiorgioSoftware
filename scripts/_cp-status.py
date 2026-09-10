#!/usr/bin/env python3
"""Status snapshot for stopship — avoid shell quoting issues."""
import json
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
s = cp.get("stats") or {}
print(json.dumps({
    "processed": s.get("processed"),
    "published": s.get("published"),
    "hot": s.get("hot"),
    "review": s.get("review"),
    "retry": s.get("retry"),
    "technical": s.get("technical"),
    "terminal": len(cp.get("terminal") or {}),
    "inProgress": len(cp.get("inProgress") or {}),
    "inProgressIds": list((cp.get("inProgress") or {}).keys())[:10],
    "retryQueue": len(cp.get("retryQueue") or {}),
}, indent=2))
