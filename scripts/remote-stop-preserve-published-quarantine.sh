#!/usr/bin/env bash
set -uo pipefail
echo "=== GRACEFUL STOP ==="
systemctl stop giorgio-revalidate || true
for i in $(seq 1 90); do
  if ! pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then break; fi
  sleep 2
done
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 2
pgrep -af production-revalidate || echo stopped
echo "=== CHECKPOINT PRESERVE (read-only snapshot) ==="
python3 - <<'PY'
import json, shutil
from pathlib import Path
from datetime import datetime, timezone
src=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
ts=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
bak=Path(f"/opt/leadsniper-revalidate/data/revalidation/checkpoint.pre-published-quarantine-{ts}.json")
shutil.copy2(src, bak)
cp=json.loads(src.read_text())
pubs={k:v for k,v in (cp.get("terminal") or {}).items() if str(v.get("processingState") or "").startswith("PUBLISHED")}
print(json.dumps({
  "backup": str(bak),
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
  "published_in_terminal": pubs,
}, indent=2))
PY
ls -la /opt/leadsniper-revalidate/data/revalidation/results | head -5
echo "results_count=$(ls /opt/leadsniper-revalidate/data/revalidation/results/*.json 2>/dev/null | wc -l)"
echo "frontiers_count=$(ls /opt/leadsniper-revalidate/data/revalidation/frontiers/*.sqlite 2>/dev/null | wc -l)"
systemctl is-active giorgio-revalidate || true
