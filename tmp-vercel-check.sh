#!/bin/bash
set -euo pipefail
curl -fsS -o /tmp/run_vercel.json 'https://giorgio-software.vercel.app/api/sanita/archive-revalidation/results?scope=run' || curl -kfsS -o /tmp/run_vercel.json 'https://giorgio-software.vercel.app/api/sanita/archive-revalidation/results?scope=run'
python3 <<'PY'
import json
j=json.load(open('/tmp/run_vercel.json'))
rs=j.get('results') or []
print('VERCEL_RUN_N', len(rs))
for r in rs:
  n=r.get('companyName') or ''
  if any(x in n for x in ('Angela','Pini','Malzoni')):
    print('VERCEL', n[:40], r.get('publishedSubtype') or r.get('processingState'), r.get('policyNumber'), r.get('policyExpiry'), r.get('website'), r.get('phone'), r.get('email'))
PY
code=$(curl -s -o /dev/null -w '%{http_code}' 'https://giorgio-software.vercel.app/api/sanita/archive-revalidation/evidence-file?sha=620c3ab95860ac2eef100e86630f8a2ffb080a6885f60e12259ced7216b547bc' || true)
echo "VERCEL_EVIDENCE_HTTP=$code"
# deployment tip may lag; check if evidence route exists on vercel (404 vs 200)
curl -sI 'https://giorgio-software.vercel.app/' | head -5
