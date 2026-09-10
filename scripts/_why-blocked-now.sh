#!/bin/bash
set -euo pipefail
PID=$(systemctl show -p MainPID --value giorgio-revalidate)
echo "MainPID=$PID"
pstree -ap "$PID" 2>/dev/null | head -n 50
echo "---CPU---"
ps -eo pid,pcpu,pmem,etime,cmd --sort=-pcpu | head -n 25
echo "---INPROGRESS---"
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
for k,v in (cp.get('inProgress') or {}).items():
  print(k, v)
print('due sample:')
s=json.load(open('/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'))
rq=cp.get('retryQueue') or {}
term=cp.get('terminal') or {}
from datetime import datetime, timezone
now=datetime.now(timezone.utc)
for r in s['records']:
  lid=r['leadId']
  if lid in term or lid in (cp.get('inProgress') or {}): continue
  meta=rq.get(lid)
  if not meta: continue
  nxt=meta.get('nextRetryAt')
  print(lid, meta.get('lastError'), 'next', nxt, 'attempts', meta.get('attempts'))
PY
echo "---LOG TAIL---"
grep -E 'frontier_quarantine|frontier_sitemap|lead_done|worker_done|spawn' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -n 30
