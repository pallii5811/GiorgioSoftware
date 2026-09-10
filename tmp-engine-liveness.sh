#!/usr/bin/env bash
set -uo pipefail
echo "--- procs (pid etimes cpu mem cmd) ---"
ps -eo pid,etimes,pcpu,pmem,args | grep -E 'revalidate|chrome' | grep -v grep | head -14
echo "--- unit io ---"
systemctl show giorgio-revalidate -p StandardOutput -p StandardError -p ExecStart -p Environment | head -8
echo "--- inProgress ---"
python3 - <<'PY'
import json
from pathlib import Path
cp = json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print(json.dumps(cp.get('inProgress'), indent=2, ensure_ascii=False)[:800])
print('updatedAt', cp.get('updatedAt'))
PY
echo "--- frontier db activity (last modified) ---"
ls -lat --time-style=+%H:%M:%S /opt/leadsniper-revalidate/data/revalidation/frontiers/ 2>/dev/null | head -6
ls -lat --time-style=+%H:%M:%S /opt/leadsniper-revalidate/data/revalidation/results/ | head -6
date +%H:%M:%S
echo "--- journal all (no unit filter, last 25) ---"
journalctl -u giorgio-revalidate --since '-8 min' --no-pager | tail -25
