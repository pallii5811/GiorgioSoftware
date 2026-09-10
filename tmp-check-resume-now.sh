#!/bin/bash
set -euo pipefail
echo "=== SERVICE ==="
systemctl is-active giorgio-revalidate || true
systemctl is-enabled giorgio-revalidate || true
systemctl status giorgio-revalidate --no-pager -l | head -35
echo "=== PROCS ==="
pgrep -af 'production-revalidate|flock.*revalidate' | head -20 || true
echo "=== FLOCK ==="
lsof /opt/leadsniper-revalidate/revalidate.parent.lock 2>/dev/null | head -10 || true
echo "=== CONTROL API ==="
curl -s http://127.0.0.1:3000/api/sanita/archive-revalidation/control | python3 -m json.tool | head -40
echo "=== ARCHIVE STATUS ==="
curl -s http://127.0.0.1:3000/api/sanita/archive-revalidation | python3 -m json.tool | head -50
echo "=== CHECKPOINT ==="
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
term=cp.get('terminal') or {}
retry=cp.get('retryQueue') or {}
ip=cp.get('inProgress') or {}
att=cp.get('attempts') or {}
print('updatedAt', cp.get('updatedAt'))
print('terminal', len(term), list(term.items())[:3])
print('retry', len(retry), list(retry.keys())[:5])
print('inProgress', len(ip), list(ip.keys())[:5])
print('attempts_n', len(att))
print('APPLY check env:')
PY
systemctl show giorgio-revalidate -p Environment --value 2>/dev/null | tr ' ' '\n' | grep -E 'APPLY_LIVE|DISABLE_LIVE|PER_HOST|REVALIDATE_IDS|CONCURRENCY|TOTAL_WORKERS' || true
echo "=== RESULTS DIR ==="
ls /opt/leadsniper-revalidate/data/revalidation/results 2>/dev/null | wc -l
ls -lt /opt/leadsniper-revalidate/data/revalidation/results 2>/dev/null | head -8
echo "=== LOG TAIL ==="
tail -40 /opt/leadsniper-revalidate/logs/systemd-revalidate.log 2>/dev/null || true
echo "=== DB SHA ==="
sha256sum /opt/leadsniper/prisma/dev.db
python3 -c "import sqlite3;print('HC',sqlite3.connect('/opt/leadsniper/prisma/dev.db').execute(\"select count(*) from Lead where type='HEALTHCARE'\").fetchone()[0])"
echo "=== DROPINS ==="
ls -la /etc/systemd/system/giorgio-revalidate.service.d/ 2>/dev/null || true
