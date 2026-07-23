#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
install -m 0644 /tmp/k3-retry-patch/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 /tmp/k3-retry-patch/revalidate-checkpoint-v3.mjs "$APP/scripts/revalidate-checkpoint-v3.mjs"
install -m 0755 /tmp/k3-retry-patch/_frontier_inspect.py "$APP/scripts/_frontier_inspect.py"
install -m 0755 /tmp/k3-retry-patch/_frontier_clear_caps.py "$APP/scripts/_frontier_clear_caps.py"
python3 <<'PY'
import json
from datetime import datetime, timezone
S='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
s=json.load(open(S)); cp=json.load(open(CP)); rq=cp.get('retryQueue') or {}
term=cp.get('terminal') or {}
n=0
for r in s['records']:
  lid=r['leadId']
  if lid in term: continue
  meta=rq.get(lid) or {
    'attempts':1,
    'lastReason':'RETRY_PENDING',
    'lastError':r.get('initialError') or 'RETRY_PENDING',
    'frontierPath':r.get('frontierPath'),
    'lastRunId':r.get('lastRunId'),
    'firstSeenAt':datetime.now(timezone.utc).isoformat(),
    'operational':True,
  }
  meta['nextRetryAt']='1970-01-01T00:00:00.000Z'
  rq[lid]=meta
  (cp.get('inProgress') or {}).pop(lid, None)
  n+=1
cp['retryQueue']=rq
cp['updatedAt']=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
json.dump(cp, open(CP,'w'), ensure_ascii=False, indent=2)
print('due_forced', n, 'term', len(term), 'sample', len(s['records']))
PY
systemctl stop giorgio-revalidate
sleep 3
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock || true
systemctl start giorgio-revalidate
sleep 6
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
systemctl is-active giorgio-revalidate
pkill -f _poll-retry20-gate.py || true
sleep 1
nohup env GATE_TIMEOUT_S=2100 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
sleep 3
tail -n 5 /tmp/retry20-gate.log || true
grep -E 'frontier_force_fresh|frontier_clear_caps|frontier_fresh|PUBLISHED|lead_done' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -n 15 || true
echo REPATCH_OK
