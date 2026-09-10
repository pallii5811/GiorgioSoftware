#!/usr/bin/env bash
# Snapshot gate + resources for RETRY20 same-sample run
set -euo pipefail
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
systemctl is-active giorgio-revalidate || true
echo "---CP---"
python3 <<'PY'
import json, os, time
from pathlib import Path
from datetime import datetime, timezone
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
s=json.load(open('/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'))
ids=[r['leadId'] for r in s['records']]
term=cp.get('terminal') or {}
rq=cp.get('retryQueue') or {}
ip=cp.get('inProgress') or {}
print(json.dumps({
  'sampleTerm': sum(1 for i in ids if i in term),
  'sampleRetry': sum(1 for i in ids if i in rq),
  'sampleInFlight': sum(1 for i in ids if i in ip),
  'totalTerm': len(term),
  'totalRetry': len(rq),
  'inProgress': len(ip),
  'applyLive': cp.get('applyLive', cp.get('flags',{}).get('applyLive')),
}, ensure_ascii=False))
print('INFLIGHT')
for i in ids:
  if i in ip:
    print(' ', i, ip[i].get('startedAt'), ip[i].get('strategy'))
print('RETRY_ERRS')
from collections import Counter
c=Counter()
for i in ids:
  if i in rq:
    c[str(rq[i].get('lastError') or rq[i].get('lastReason') or '?')] += 1
for k,v in c.most_common():
  print(f'  {k}: {v}')
print('TERMINALS')
for i in ids:
  if i in term:
    print(' T', i, term[i].get('processingState'), term[i].get('reasonCode'))
PY
echo "---RES---"
PID=$(systemctl show -p MainPID --value giorgio-revalidate)
if [[ -n "$PID" && "$PID" != "0" ]]; then
  ps -p "$PID" -o pid,pcpu,pmem,rss,etime,cmd --no-headers || true
  # child workers
  pgrep -P "$PID" | head -n 20 | while read c; do ps -p "$c" -o pid,pcpu,pmem,rss,etime,cmd --no-headers; done || true
fi
free -m | head -n 2
nproc
echo "OCR_Q=$(ls /opt/leadsniper-revalidate/data/ocr-queue 2>/dev/null | wc -l || echo 0)"
echo "---LOG---"
grep -E 'lead_done|frontier_force_fresh|frontier_resume|concurrency_|worker_done' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -n 25
echo "---GATE_LOG---"
tail -n 8 /tmp/retry20-gate.log || true
