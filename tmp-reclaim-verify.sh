#!/bin/bash
set -euo pipefail
echo "=== PARENTS BEFORE ==="
pgrep -af 'production-revalidate-sanita' || true
# Keep newest parent only; kill extras + orphan workers if needed
mapfile -t PARENTS < <(pgrep -f 'production-revalidate-sanita-v3.mjs' | while read p; do
  # skip if cmdline contains worker
  tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q worker && continue
  echo "$p"
done)
echo "PARENT_PIDS=${PARENTS[*]:-}"
if ((${#PARENTS[@]} > 1)); then
  KEEP="${PARENTS[-1]}"
  for p in "${PARENTS[@]}"; do
    if [[ "$p" != "$KEEP" ]]; then
      echo "KILL_EXTRA_PARENT $p"
      kill "$p" 2>/dev/null || true
    fi
  done
  sleep 2
fi
# If systemd manages it, restart clean once to reclaim single parent
systemctl restart giorgio-revalidate
sleep 5
echo "=== AFTER RESTART ==="
systemctl is-active giorgio-revalidate
pgrep -af 'production-revalidate-sanita' || true
PARENT_N=$(pgrep -af 'production-revalidate-sanita-v3.mjs' | grep -v worker | grep -vc pgrep || true)
echo "PARENT_N=$PARENT_N"
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
python3 <<'PY'
import json, hashlib
from pathlib import Path
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
aid='cmqkld5s2009y108ejvgl7m92'
pini='cmqklex5q00bh108eq9blm01k'
malz='cmqktyimz000i111hygme29nh'
print('CHECKPOINT_TERMINAL_N', len(cp.get('terminal',{})))
print('CHECKPOINT_RETRY_N', len(cp.get('retryQueue',{})))
print('CHECKPOINT_IP_N', len(cp.get('inProgress',{})))
print('ANGELA', cp['terminal'].get(aid))
print('PINI', cp['terminal'][pini]['processingState'])
print('MALZ', cp['terminal'][malz]['processingState'])
r=json.loads(Path(f'/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json').read_text())
print('RESULT', r.get('publishedSubtype'), r.get('policyNumber'), r.get('policyExpiry'), r.get('policyCompany'))
print('CONTACTS', r.get('website'), r.get('phone'), r.get('email'), r.get('pec'), r.get('piva'))
print('EVIDENCE_SHA', (r.get('evidenceFileSha256') or r.get('contentHash') or '')[:16])
db=Path('/opt/leadsniper/prisma/dev.db').read_bytes()
print('DB_SHA', hashlib.sha256(db).hexdigest())
PY
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' -o /tmp/run_final.json
python3 <<'PY'
import json
j=json.load(open('/tmp/run_final.json'))
for r in j.get('results') or []:
  n=r.get('companyName') or ''
  if any(x in n for x in ('Angela','Pini','Malzoni')):
    print('API_ROW', n[:40], r.get('publishedSubtype') or r.get('processingState'), r.get('policyNumber'), r.get('policyExpiry'), r.get('website'), r.get('phone'), r.get('email'))
print('RUN_N', len(j.get('results') or []))
sha='620c3ab95860ac2eef100e86630f8a2ffb080a6885f60e12259ced7216b547bc'
import urllib.request
code=urllib.request.urlopen(f'http://127.0.0.1:3000/api/sanita/archive-revalidation/evidence-file?sha={sha}').status
print('EVIDENCE_HTTP', code)
PY
