#!/usr/bin/env python3
"""Force all targeted retries due now (preserve frontiers/results)."""
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
cp = json.loads((OUT / "checkpoint.json").read_text())
now = datetime.now(timezone.utc)
n = 0
for lid, m in (cp.get("retryQueue") or {}).items():
    m["nextRetryAt"] = (now - timedelta(seconds=10)).isoformat()
    m["operational"] = True
    m.pop("parkedEngineCeiling", None)
    n += 1
cp["updatedAt"] = now.isoformat()
(OUT / "checkpoint.json").write_text(json.dumps(cp, indent=2))
print(json.dumps({"bumped": n, "ip": list((cp.get("inProgress") or {}).keys())}))
