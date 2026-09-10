#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json
from datetime import datetime, timezone
S='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
s=json.load(open(S)); cp=json.load(open(CP)); rq=cp.get('retryQueue') or {}; term=cp.get('terminal') or {}
n=0
for r in s['records']:
  lid=r['leadId']
  if lid in term: continue
  meta=rq.get(lid)
  if not meta: continue
  meta['nextRetryAt']='1970-01-01T00:00:00.000Z'
  rq[lid]=meta
  n+=1
cp['retryQueue']=rq
cp['updatedAt']=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
json.dump(cp, open(CP,'w'), ensure_ascii=False, indent=2)
print('due', n, 'sample_term', sum(1 for r in s['records'] if r['leadId'] in term), 'total_term', len(term), 'retry', len(rq))
print('PID_KEEP', open('/proc/1/cmdline','rb').read()[:0].decode())
PY
echo "REVAL_PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
# refresh poller only
pkill -f _poll-retry20-gate.py || true
sleep 1
# update sample terminalBefore to 25 still
python3 - <<'PY'
import json
S='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'
s=json.load(open(S))
s['terminalBefore']=25
s['retryBefore']=18
json.dump(s, open(S,'w'), ensure_ascii=False, indent=2)
PY
nohup env GATE_TIMEOUT_S=1800 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
