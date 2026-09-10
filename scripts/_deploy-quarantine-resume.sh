#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
install -m 0644 /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 /tmp/production-revalidate-sanita-worker.mjs "$APP/scripts/production-revalidate-sanita-worker.mjs"
install -m 0755 /tmp/_frontier_inspect.py "$APP/scripts/_frontier_inspect.py"
install -m 0755 /tmp/_frontier_quarantine_blocked.py "$APP/scripts/_frontier_quarantine_blocked.py"
# Also keep helpers next to OUT_DIR scripts path if different
cp -f "$APP/scripts/_frontier_inspect.py" /opt/leadsniper-revalidate/scripts/_frontier_inspect.py 2>/dev/null || true
cp -f "$APP/scripts/_frontier_quarantine_blocked.py" /opt/leadsniper-revalidate/scripts/_frontier_quarantine_blocked.py 2>/dev/null || true

python3 <<'PY'
import json, subprocess
from datetime import datetime, timezone
from pathlib import Path

APP = Path("/opt/leadsniper-revalidate/app")
Q = APP / "scripts/_frontier_quarantine_blocked.py"
cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
sample = json.loads(Path("/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json").read_text())
cp = json.loads(cp_path.read_text())
rq = cp.get("retryQueue") or {}
term = cp.get("terminal") or {}
ip = cp.get("inProgress") or {}
n_due = 0
n_q = 0
for r in sample["records"]:
    lid = r["leadId"]
    if lid in term:
        continue
    meta = rq.get(lid) or {}
    fp = meta.get("frontierPath") or r.get("frontierPath")
    err = str(meta.get("lastError") or meta.get("lastReason") or r.get("initialError") or "")
    if fp and Path(fp).exists():
        args = ["python3", str(Q), fp]
        if "PDF" in err.upper() or "ANALYZE" in err.upper() or "WALL" in err.upper():
            args.append("--isolate-pdfs")
        try:
            out = subprocess.check_output(args, text=True, timeout=8).strip()
            print(lid, out)
            n_q += 1
        except Exception as e:
            print(lid, "quarantine_err", e)
    if meta:
        meta["nextRetryAt"] = "1970-01-01T00:00:00.000Z"
        rq[lid] = meta
        n_due += 1
    if lid in ip:
        del ip[lid]
cp["retryQueue"] = rq
cp["inProgress"] = ip
cp["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
cp_path.write_text(json.dumps(cp, ensure_ascii=False, indent=2))
print(json.dumps({"quarantinedLeads": n_q, "forcedDue": n_due, "sampleTerm": sum(1 for r in sample["records"] if r["leadId"] in term), "term": len(term), "retry": len(rq)}))
PY

systemctl restart giorgio-revalidate
sleep 4
systemctl is-active giorgio-revalidate
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
pkill -f _poll-retry20-gate.py || true
sleep 1
nohup env GATE_TIMEOUT_S=3600 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
