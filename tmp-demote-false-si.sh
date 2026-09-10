#!/bin/bash
set -euo pipefail
# Demote canary false SELF_INSURANCE on Villa Dei Pini → REVIEW (do not present as certified).
# Does NOT touch live DB. Leaves service inactive/enabled.
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
CP=Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')
RES=Path('/opt/leadsniper-revalidate/data/revalidation/results/cmqklex5q00bh108eq9blm01k.json')
cp=json.loads(CP.read_text(encoding='utf-8'))
tid='cmqklex5q00bh108eq9blm01k'
term=cp.get('terminal') or {}
if tid in term and term[tid].get('processingState')=='SELF_INSURANCE_VERIFIED':
  del term[tid]
  cp['terminal']=term
  rq=cp.setdefault('retryQueue',{})
  rq[tid]={
    'attempts': (cp.get('attempts') or {}).get(tid,1),
    'lastReason':'FALSE_SI_DEMOTE_CANARY',
    'lastError':'Villa Dei Pini legacy PUB PDF — SI without evidence text',
    'nextRetryAt': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
    'firstSeenAt': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
    'lastAttemptAt': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
  }
  if 'inProgress' in cp and tid in (cp.get('inProgress') or {}):
    del cp['inProgress'][tid]
  CP.write_text(json.dumps(cp,indent=2),encoding='utf-8')
  print('DEMOTED_TERMINAL_TO_RETRY')
else:
  print('NO_SI_TERMINAL', term.get(tid))
if RES.exists():
  j=json.loads(RES.read_text(encoding='utf-8'))
  j['processingState']='REVIEW_HUMAN'
  j['businessVerdict']='REVIEW_HUMAN'
  j['newVerdict']='REVIEW'
  j['reasonCode']='FALSE_SI_DEMOTE_CANARY'
  RES.write_text(json.dumps(j,indent=2),encoding='utf-8')
  print('RESULT_MARKED_REVIEW')
print('terminal_n', len(cp.get('terminal') or {}))
print('retry_n', len(cp.get('retryQueue') or {}))
PY
systemctl stop giorgio-revalidate 2>/dev/null || true
systemctl enable giorgio-revalidate
echo active=$(systemctl is-active giorgio-revalidate || true)
echo enabled=$(systemctl is-enabled giorgio-revalidate)
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' | python3 -c "import sys,json;j=json.load(sys.stdin);print('run_n',len(j.get('results')or[]))"
sha256sum /opt/leadsniper/prisma/dev.db
