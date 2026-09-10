#!/bin/bash
set -euo pipefail
for i in $(seq 1 50); do
  if grep -q '^CANARY_DONE' /tmp/canary3-gates.log 2>/dev/null; then
    echo DONE
    tail -80 /tmp/canary3-gates.log
    exit 0
  fi
  python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('poll term', len(cp.get('terminal') or {}), 'retry', len(cp.get('retryQueue') or {}), 'ip', len(cp.get('inProgress') or {}))
PY
  echo active=$(systemctl is-active giorgio-revalidate || true)
  tail -2 /opt/leadsniper-revalidate/logs/systemd-revalidate.log || true
  sleep 30
done
echo TIMEOUT
tail -50 /tmp/canary3-gates.log
exit 1
