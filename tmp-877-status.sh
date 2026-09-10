#!/bin/bash
set -euo pipefail
echo "=== SERVICE ==="
systemctl is-active giorgio-revalidate || true
systemctl show giorgio-revalidate -p ActiveState,SubState,MainPID,NRestarts --value
echo "=== ENV ==="
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value giorgio-revalidate)/environ 2>/dev/null | grep -E 'APPLY_LIVE|REVALIDATE_CONCURRENCY|REVALIDATE_CHECKPOINT|RELEASE|GIT_HEAD|DUAL' || true
echo "RELEASE_FILE=$(cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null)"
echo "=== CHECKPOINT ==="
python3 <<'PY'
import json, hashlib
from pathlib import Path
from datetime import datetime, timezone
p=Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')
cp=json.loads(p.read_text())
term=len(cp.get('terminal') or {})
retry=len(cp.get('retryQueue') or {})
ip=list((cp.get('inProgress') or {}).keys())
stats=cp.get('stats') or {}
print('sha', hashlib.sha256(p.read_bytes()).hexdigest()[:16])
print('testedCodeSha', cp.get('testedCodeSha'))
print('terminal', term)
print('retry', retry)
print('inProgress', ip[:5], 'n=', len(ip))
print('stats', {k:stats.get(k) for k in ('processed','hot','pub','review','tech','retry','outOfScope') if k in stats or True})
print('updatedAt', cp.get('updatedAt'))
# classify terminals
from collections import Counter
c=Counter()
for v in (cp.get('terminal') or {}).values():
  if isinstance(v, dict):
    c[v.get('processingState') or v.get('newVerdict') or '?'] += 1
  else:
    c[str(type(v))] += 1
print('terminal_states', dict(c.most_common(12)))
# retry reasons
rc=Counter()
for v in (cp.get('retryQueue') or {}).values():
  if isinstance(v, dict):
    rc[str(v.get('lastReason') or v.get('lastError') or '?')[:60]] += 1
print('retry_reasons', dict(rc.most_common(8)))
print('remaining_est', 877 - term)
print('pct', round(100*term/877, 2))
PY
echo "=== PROCS ==="
pgrep -af 'production-revalidate-sanita' | head -10 || echo none
echo "=== LOG TAIL ==="
tail -n 25 /opt/leadsniper-revalidate/logs/systemd-revalidate.log
echo "=== ERRORS RECENT ==="
grep -E 'TECHNICAL_BLOCKED|ANALYZE_ERROR|LEAD_WALL|WORKER_SIGTERM|PARENT_CATCH|TypeError|Error' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -20 || true
echo "=== DB ==="
python3 - <<'PY'
import hashlib
from pathlib import Path
print(hashlib.sha256(Path('/opt/leadsniper/prisma/dev.db').read_bytes()).hexdigest())
PY
