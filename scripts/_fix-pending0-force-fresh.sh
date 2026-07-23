#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
# Deploy only the coordinator patch; do not wipe checkpoint / frontiers.
install -m 0644 /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
# Make sample retries due now (no CP wipe). Single parent via systemctl restart.
python3 <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path
cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
sample = json.loads(Path("/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json").read_text())
ids = {r["leadId"] for r in sample["records"]}
cp = json.loads(cp_path.read_text())
rq = cp.get("retryQueue") or {}
term = cp.get("terminal") or {}
ip = cp.get("inProgress") or {}
n = 0
for lid in ids:
    if lid in term:
        continue
    meta = rq.get(lid)
    if not meta:
        continue
    meta["nextRetryAt"] = "1970-01-01T00:00:00.000Z"
    rq[lid] = meta
    n += 1
    if lid in ip:
        del ip[lid]
cp["retryQueue"] = rq
cp["inProgress"] = ip
cp["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
cp_path.write_text(json.dumps(cp, ensure_ascii=False, indent=2))
print(json.dumps({
    "forcedDue": n,
    "sampleSize": len(ids),
    "sampleTerm": sum(1 for i in ids if i in term),
    "term": len(term),
    "retry": len(rq),
}))
PY
systemctl restart giorgio-revalidate
sleep 4
systemctl is-active giorgio-revalidate
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
# refresh poller on same sample
pkill -f _poll-retry20-gate.py || true
sleep 1
nohup env GATE_TIMEOUT_S=2400 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
