#!/usr/bin/env bash
set -euo pipefail
python3 /tmp/tmp-patch-html-policy-miss.py
bash /tmp/tmp-probe-detector-miss.sh
systemctl restart giorgio-revalidate
sleep 3
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
for lid in ['cmqma6d8e000q9g5crb0tkxag','cmqmctogz008i9g5ctaoy1ii1']:
  t=cp['terminal'][lid]
  r=json.load(open(f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'))
  print(lid, 'term', t.get('processingState'), 'num', t.get('policyNumber') or r.get('policyNumber'), 'co', t.get('policyCompany') or r.get('policyCompany'), 'pf', r.get('policyFound'))
PY
