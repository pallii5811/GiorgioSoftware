#!/usr/bin/env bash
# Monitor micro-canary 10 without interfering.
set -euo pipefail
LOG=/opt/leadsniper-revalidate/data/k3-stopship/micro-canary10-run.log
OUT=/opt/leadsniper-revalidate/data/k3-stopship/MICRO_CANARY10_RESULTS.json
echo "=== procs ==="
pgrep -af 'k3-micro-canary10|production-revalidate-sanita' | grep -v grep || echo none
echo "=== progress ==="
grep k3_progress "$LOG" | tail -20
echo "=== tail ==="
tail -n 15 "$LOG"
echo "=== results file ==="
if [ -f "$OUT" ]; then
  python3 - <<'PY'
import json
from pathlib import Path
d=json.loads(Path("/opt/leadsniper-revalidate/data/k3-stopship/MICRO_CANARY10_RESULTS.json").read_text())
print(json.dumps({k:d.get(k) for k in ("verdict","gate","byState","stopReasons")}, indent=2, default=str)[:2000])
PY
else
  echo "MICRO_CANARY10_RESULTS.json not yet"
fi
python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print(json.dumps({
  "updatedAt": c.get("updatedAt"),
  "terminal": len(c.get("terminal") or {}),
  "retry": len(c.get("retryQueue") or {}),
  "inProgress": list((c.get("inProgress") or {}).keys()),
}, indent=2))
PY
