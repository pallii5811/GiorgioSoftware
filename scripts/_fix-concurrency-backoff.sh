#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
install -m 0644 /tmp/k3-retry-patch/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
python3 <<'PY'
import json
from datetime import datetime, timezone
S='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
s=json.load(open(S)); cp=json.load(open(CP)); rq=cp.get('retryQueue') or {}; term=cp.get('terminal') or {}; inp=cp.get('inProgress') or {}
# Move stale inProgress (>12min) back to retry due immediately
import time
now=time.time()
moved=0
for lid, meta in list(inp.items()):
  started=meta.get('startedAt')
  try:
    ts=datetime.fromisoformat(started.replace('Z','+00:00')).timestamp()
  except Exception:
    ts=now-9999
  if now-ts > 12*60:
    rq[lid]={
      'attempts': (cp.get('attempts') or {}).get(lid) or 1,
      'lastReason': 'IN_PROGRESS_STALE_SLICE',
      'lastError': 'LEAD_WALL_TIMEOUT',
      'nextRetryAt': '1970-01-01T00:00:00.000Z',
      'lastRunId': meta.get('runId'),
      'frontierPath': meta.get('frontierPath'),
      'strategy': meta.get('strategy') or 'resume_boost',
      'firstSeenAt': started,
      'lastAttemptAt': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
      'operational': True,
    }
    del inp[lid]
    moved+=1
for r in s['records']:
  lid=r['leadId']
  if lid in term: continue
  if lid in rq:
    rq[lid]['nextRetryAt']='1970-01-01T00:00:00.000Z'
cp['inProgress']=inp
cp['retryQueue']=rq
json.dump(cp, open(CP,'w'), ensure_ascii=False, indent=2)
print('moved_stale', moved, 'sample_term', sum(1 for r in s['records'] if r['leadId'] in term), 'term', len(term), 'retry', len(rq))
PY
systemctl stop giorgio-revalidate
sleep 3
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock || true
systemctl start giorgio-revalidate
sleep 6
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
pkill -f _poll-retry20-gate.py || true
sleep 1
nohup env GATE_TIMEOUT_S=2400 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
sleep 5
tail -n 5 /tmp/retry20-gate.log
echo CONCURRENCY_FIX_OK
