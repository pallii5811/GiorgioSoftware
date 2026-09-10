#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime, timezone

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
LID = "cmqklex5g00b6108ejom1shk0"
cp = json.loads((OUT / "checkpoint.json").read_text(encoding="utf-8"))
print("top_keys", list(cp.keys())[:30])
# find malzoni
found = []

def walk(obj, path="$"):
    if isinstance(obj, dict):
        if LID in obj and isinstance(obj[LID], dict):
            found.append((path, obj[LID]))
        for k, v in obj.items():
            walk(v, path + "." + str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            walk(v, path + f"[{i}]")

walk(cp)
print("found_paths", [p for p, _ in found])
for p, e in found:
    print(p, {k: e.get(k) for k in (
        "attempts", "forceDue", "nextRetryAt", "parkedEngineCeiling", "lastReason",
        "lastError", "processingState", "strategy", "lastRunId", "frontierPath", "status"
    )})

# also inspect retry queue structures
for k in ("retry", "retryQueue", "pending", "leads", "results", "items"):
    if k in cp:
        v = cp[k]
        print(k, type(v).__name__, (len(v) if hasattr(v, "__len__") else v))
