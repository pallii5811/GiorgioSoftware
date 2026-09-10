#!/usr/bin/env python3
import json, os
from pathlib import Path
cp = json.loads(Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json").read_text())
att = cp.get("attempts") or {}
rq = cp.get("retryQueue") or {}
print("ge5", {k: v for k, v in att.items() if int(v or 0) >= 5})
print(
    "rq_ge5",
    {
        k: (m.get("attempts"), m.get("parkedEngineCeiling"))
        for k, m in rq.items()
        if int(m.get("attempts") or 0) >= 5
    },
)
print(
    "snap",
    {
        "term": len(cp.get("terminal") or {}),
        "retry": len(rq),
        "ip": list((cp.get("inProgress") or {}).keys()),
    },
)
