#!/usr/bin/env python3
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
cp = json.loads((OUT / "checkpoint.json").read_text())
now = datetime.now(timezone.utc)
# Unpark Malzoni after light leads — restore attempts under ceiling
for lid in ("cmqklex5g00b6108ejom1shk0", "cmql4qrih0010c9w7x74d84gt", "cmqmaf02a001k9g5crmkdun0w"):
    m = (cp.get("retryQueue") or {}).get(lid)
    if not m:
        continue
    m["attempts"] = min(int(m.get("attempts") or 0), 3)
    cp.setdefault("attempts", {})[lid] = m["attempts"]
    m.pop("parkedEngineCeiling", None)
    if lid == "cmqklex5g00b6108ejom1shk0":
        m["nextRetryAt"] = (now + timedelta(minutes=25)).isoformat()
    else:
        m["nextRetryAt"] = (now - timedelta(seconds=5)).isoformat()
    m["operational"] = True
(OUT / "checkpoint.json").write_text(json.dumps(cp, indent=2))
print({k: (cp["retryQueue"][k].get("attempts"), cp["retryQueue"][k].get("nextRetryAt")[:19]) for k in cp.get("retryQueue") or {}})
