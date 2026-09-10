#!/usr/bin/env bash
# Demote any HOT_VERIFIED terminal without pass2 back to retryQueue (fail-closed).
set -uo pipefail
python3 - <<'PY'
import json, pathlib, datetime
from pathlib import Path
cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
res_dir = Path("/opt/leadsniper-revalidate/data/revalidation/results")
cp = json.loads(cp_path.read_text())
moved = []
for lid, meta in list((cp.get("terminal") or {}).items()):
    rp = res_dir / f"{lid}.json"
    if not rp.exists():
        continue
    row = json.loads(rp.read_text())
    ps = meta.get("processingState") or row.get("processingState")
    if ps == "HOT_VERIFIED" and not row.get("pass2"):
        del cp["terminal"][lid]
        attempts = (cp.get("attempts") or {}).get(lid, 1)
        cp.setdefault("retryQueue", {})[lid] = {
            "attempts": attempts,
            "lastReason": "HOT_WITHOUT_DUAL_PASS",
            "lastError": "demoted_for_dual_hot",
            "nextRetryAt": datetime.datetime.now(datetime.UTC).isoformat(),
            "lastRunId": (row.get("runIds") or [None])[0],
            "frontierPath": (row.get("frontierPaths") or [None])[0],
            "firstSeenAt": meta.get("finishedAt") or row.get("finishedAt"),
            "lastAttemptAt": datetime.datetime.now(datetime.UTC).isoformat(),
        }
        row["processingState"] = "RETRY_PENDING"
        row["businessVerdict"] = None
        row["newVerdict"] = None
        row["token"] = None
        row["terminal"] = False
        row["reasonCode"] = "HOT_WITHOUT_DUAL_PASS"
        row["dualDisagreement"] = False
        rp.write_text(json.dumps(row, indent=2))
        moved.append(lid)
        if cp.get("stats"):
            cp["stats"]["hot"] = max(0, (cp["stats"].get("hot") or 0) - 1)
            cp["stats"]["terminal"] = max(0, (cp["stats"].get("terminal") or 0) - 1)
            cp["stats"]["retry"] = (cp["stats"].get("retry") or 0) + 1
cp["updatedAt"] = __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat()
cp_path.write_text(json.dumps(cp, indent=2))
print(json.dumps({"demoted_hot_without_dual": moved, "terminal": len(cp.get("terminal") or {}), "retry": len(cp.get("retryQueue") or {})}, indent=2))
PY
