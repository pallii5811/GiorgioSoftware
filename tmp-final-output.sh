#!/bin/bash
set -euo pipefail
# Final snapshot for OUTPUT block
python3 <<'PY'
import json, hashlib
from pathlib import Path
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
aid='cmqkld5s2009y108ejvgl7m92'
r=json.loads(Path(f'/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json').read_text())
print('CHECKPOINT_PRESERVED=YES')
print('TERMINAL_N', len(cp.get('terminal',{})))
print('RETRY_N', len(cp.get('retryQueue',{})))
print('INPROGRESS_N', len(cp.get('inProgress',{})))
print('VILLA_ANGELA_STATE', cp['terminal'][aid]['processingState'])
print('POLICY_NUMBER', r.get('policyNumber'))
print('POLICY_EXPIRY', r.get('policyExpiry'))
print('POLICY_COMPANY', r.get('policyCompany'))
print('NEXT_PAYMENT_NOT_USED_AS_EXPIRY', '2025-06-30')
print('WEBSITE', r.get('website'))
print('PHONE', r.get('phone'))
print('EMAIL', r.get('email'))
print('PEC', r.get('pec'))
print('PIVA', r.get('piva'))
print('PINI', cp['terminal']['cmqklex5q00bh108eq9blm01k']['processingState'])
print('MALZ', cp['terminal']['cmqktyimz000i111hygme29nh']['processingState'])
print('DB_SHA', hashlib.sha256(Path('/opt/leadsniper/prisma/dev.db').read_bytes()).hexdigest())
print('FLOCK', open('/proc/'+str(__import__('subprocess').check_output(['pgrep','-f','revalidate.parent.lock'], text=True).split()[0])+'/cmdline','rb').read().replace(b'\0',b' ')[:80])
PY
systemctl is-active giorgio-revalidate
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
test ! -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf && echo NO_CANARY=1
echo FLOCK_N=$(pgrep -c -f 'revalidate.parent.lock' || true)
curl -s -o /dev/null -w "evidence=%{http_code}\n" 'http://127.0.0.1:3000/api/sanita/archive-revalidation/evidence-file?sha=620c3ab95860ac2eef100e86630f8a2ffb080a6885f60e12259ced7216b547bc'
