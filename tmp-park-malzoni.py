#!/usr/bin/env python3
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
cp = json.loads((OUT / "checkpoint.json").read_text())
now = datetime.now(timezone.utc)
malzoni = "cmqklex5g00b6108ejom1shk0"
rq = cp.get("retryQueue") or {}
# park Malzoni briefly so lighter finalize leads finish first
if malzoni in rq:
    rq[malzoni]["nextRetryAt"] = (now + timedelta(minutes=40)).isoformat()
for lid, m in rq.items():
    if lid == malzoni:
        continue
    if lid in (cp.get("inProgress") or {}):
        continue
    m["nextRetryAt"] = (now - timedelta(seconds=5)).isoformat()
    m["operational"] = True
(OUT / "checkpoint.json").write_text(json.dumps(cp, indent=2))
print({"parked": malzoni, "retry": list(rq), "ip": list((cp.get("inProgress") or {}).keys())})
