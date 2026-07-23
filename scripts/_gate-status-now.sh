#!/usr/bin/env bash
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
systemctl is-active giorgio-revalidate
grep -E 'frontier_force_fresh|frontier_clear_caps|frontier_fresh|PUBLISHED_|SELF_INSURANCE|HOT_VERIFIED' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tail -n 40
echo ---GATE---
tail -n 15 /tmp/retry20-gate.log
python3 - <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
s=json.load(open('/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json'))
term=cp.get('terminal') or {}
rq=cp.get('retryQueue') or {}
ids=[r['leadId'] for r in s['records']]
term_n=sum(1 for i in ids if i in term)
retry_n=sum(1 for i in ids if i in rq)
print('sample_terminalized', term_n, 'sample_retry', retry_n, 'total_term', len(term), 'total_retry', len(rq))
for i in ids:
  if i in term:
    print('T', i, term[i].get('processingState'))
PY
