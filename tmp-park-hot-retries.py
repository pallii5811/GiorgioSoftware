#!/usr/bin/env python3
"""Park hot-loop PDF retries so new leads can progress (concurrency=1)."""
from __future__ import annotations

import json
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
bak = CP.with_suffix(f".json.bak-park-{int(time.time())}")
shutil.copy2(CP, bak)
print("backup", bak)

cp = json.loads(CP.read_text(encoding="utf-8"))
rq = cp.get("retryQueue") or {}
park_until = (datetime.now(timezone.utc) + timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
parked = []
for lid, meta in list(rq.items()):
    attempts = int(meta.get("attempts") or 0)
    reason = str(meta.get("lastReason") or "")
    hot = attempts >= 20 or (reason == "PDF_UNPROCESSED" and attempts >= 8)
    if not hot:
        continue
    meta["nextRetryAt"] = park_until
    meta["parkedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    meta["parkReason"] = f"hot_loop_{reason}_attempts_{attempts}"
    # drop frontier resume so next attempt (in 12h) is cleaner
    meta.pop("frontierPath", None)
    meta["strategy"] = "fresh"
    rq[lid] = meta
    parked.append({"id": lid, "attempts": attempts, "reason": reason})

cp["retryQueue"] = rq
cp["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
# clear inProgress so pump can pick new after restart
cp["inProgress"] = {}
tmp = CP.with_suffix(".json.tmp")
tmp.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
tmp.replace(CP)
print("parked", len(parked), "until", park_until)
for p in parked:
    print(p)
print("retry_left", len(rq))
