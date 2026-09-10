#!/usr/bin/env bash
set -uo pipefail
echo "=== PARENT TREE ==="
pgrep -af 'flock.*revalidate.parent|production-revalidate-sanita-v3' | head -20
echo "flock_holders=$(lsof /opt/leadsniper-revalidate/revalidate.parent.lock 2>/dev/null | wc -l)"
echo "=== CP ==="
python3 - <<'PY'
import json, os, time
from pathlib import Path
from datetime import datetime, timezone
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
term=cp.get("terminal") or {}
retry=cp.get("retryQueue") or {}
inp=cp.get("inProgress") or {}
started=cp.get("startedAt")
try:
  hours=(datetime.now(timezone.utc)-datetime.fromisoformat(started.replace("Z","+00:00"))).total_seconds()/3600
except: hours=None
rate=len(term)/hours if hours and hours>0 else None
eta=(877-len(term))/rate if rate else None
print(json.dumps({
  "terminal": len(term),
  "retry": len(retry),
  "inProgress": len(inp),
  "by_state": {k: sum(1 for v in term.values() if v.get("processingState")==k) for k in sorted({v.get("processingState") for v in term.values()})},
  "inProgress_ids": list(inp.keys()),
  "hours_since_cp_start": round(hours,2) if hours else None,
  "terminals_per_hour_lifetime": round(rate,2) if rate else None,
  "eta_hours_lifetime": round(eta,1) if eta else None,
}, indent=2))
# recent lead_done from log
PY
echo "=== RECENT lead_done ==="
grep -a 'lead_done' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 15
echo "=== MEM ==="
free -h | head -2
echo "=== active ==="
systemctl is-active giorgio-revalidate
