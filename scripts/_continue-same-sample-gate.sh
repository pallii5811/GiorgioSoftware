#!/usr/bin/env bash
# Continue same sample gate — do not change sample IDs. Force due + longer poll.
set -euo pipefail
python3 <<'PY'
import json
from datetime import datetime, timezone
S='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
G='/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_GATE.json'
s=json.load(open(S)); cp=json.load(open(CP)); rq=cp.get('retryQueue') or {}; term=cp.get('terminal') or {}
# keep terminalBefore from original freeze
orig_term_before = 25
if __import__('os').path.isfile(G):
  try:
    g=json.load(open(G))
    orig_term_before = g.get('terminalBefore', 25)
  except Exception:
    pass
s['terminalBefore']=orig_term_before
s['retryBefore']=18
due=0
for r in s['records']:
  lid=r['leadId']
  if lid in term: continue
  meta=rq.get(lid) or {'attempts':1,'lastReason':'CRAWL_CAP','lastError':'CRAWL_CAP','frontierPath':r.get('frontierPath'),'lastRunId':r.get('lastRunId'),'operational':True}
  meta['nextRetryAt']='1970-01-01T00:00:00.000Z'
  # Prefer fresh after any prior CAP/INCOMPLETE for empty-stuck leads
  err=str(meta.get('lastError') or '')
  if any(x in err.upper() for x in ('CRAWL_CAP','FRONTIER','SITEMAP','PDF_UNPROCESSED','LEAD_WALL','SIGTERM')):
    meta['strategy']='resume_boost'
  rq[lid]=meta
  (cp.get('inProgress') or {}).pop(lid, None)
  due+=1
cp['retryQueue']=rq
json.dump(cp, open(CP,'w'), ensure_ascii=False, indent=2)
json.dump(s, open(S,'w'), ensure_ascii=False, indent=2)
print(json.dumps({'due':due,'term_now':len(term),'sample_term':sum(1 for r in s['records'] if r['leadId'] in term)}))
PY
# bump concurrency slightly if RAM allows
mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/slice-retry.conf <<'EOF'
[Service]
Environment=REVALIDATE_SLICE_WALL_MS=720000
Environment=REVALIDATE_RETRY_BASE_MS=45000
Environment=REVALIDATE_MAX_RETRY=10
Environment=CRAWL_HTML_URL_CAP=120
Environment=CRAWL_MAX_HTML_PER_SLICE=30
Environment=PER_HOST_CONCURRENCY=1
Environment=TOTAL_WORKERS=3
Environment=REVALIDATE_CONCURRENCY=3
EOF
systemctl daemon-reload
systemctl stop giorgio-revalidate
sleep 3
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock || true
systemctl start giorgio-revalidate
sleep 6
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
pkill -f _poll-retry20-gate.py || true
sleep 1
# Rewrite sample terminalBefore into gate poller input via env
nohup env GATE_TIMEOUT_S=2400 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
sleep 3
tail -n 3 /tmp/retry20-gate.log
echo CONTINUE_GATE_OK
