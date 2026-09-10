#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json
from pathlib import Path
lid="cmqklex5c00b1108e02wl0eqd"
rp=Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json")
print("exists", rp.exists())
if rp.exists():
  row=json.loads(rp.read_text())
  print(json.dumps({
    "processingState": row.get("processingState"),
    "token": row.get("token"),
    "newVerdict": row.get("newVerdict"),
    "crawlComplete": row.get("crawlComplete"),
    "policyFound": row.get("policyFound"),
    "pass2": row.get("pass2"),
    "pass2_type": str(type(row.get("pass2"))),
    "dualDisagreement": row.get("dualDisagreement"),
    "reasonCode": row.get("reasonCode"),
    "schemaVersion": row.get("schemaVersion"),
    "runIds": row.get("runIds"),
  }, indent=2, default=str))
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print("in_terminal", lid in (cp.get("terminal") or {}))
print("in_retry", lid in (cp.get("retryQueue") or {}))
print("terminal_meta", json.dumps((cp.get("terminal") or {}).get(lid), indent=2))
PY
