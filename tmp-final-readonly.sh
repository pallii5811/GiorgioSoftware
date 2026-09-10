#!/bin/bash
set -euo pipefail
# READONLY final facts — do NOT start the full 877 engine.
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/opt/leadsniper-revalidate/data/revalidation/results/cmqklex5q00bh108eq9blm01k.json')
j=json.loads(p.read_text(encoding='utf-8'))
print(json.dumps({k:j.get(k) for k in ['id','companyName','processingState','newVerdict','reasonCode','businessVerdict','evidence','policyCompany','policyNumber','policyExpiry','pass1','pass2']}, ensure_ascii=False, indent=2)[:4000])
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('CP_terminal', cp.get('terminal'))
print('CP_retry_type', type(cp.get('retryQueue')).__name__, 'n', len(cp.get('retryQueue') or {}))
print('CP_ip_type', type(cp.get('inProgress')).__name__, 'n', len(cp.get('inProgress') or {}))
# live DB legacy evidence for same id
import sqlite3
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
row=c.execute('select companyName, substr(evidence,1,300), policyExpiry from Lead where id=?',('cmqklex5q00bh108eq9blm01k',)).fetchone()
print('LIVE', row[0] if row else None)
print('LIVE_EV', (row[1] if row else '')[:300])
print('LIVE_EXP', row[2] if row else None)
PY
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' -o /tmp/run.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/run.json'))
print('RUN_N', len(j.get('results') or []))
for r in j.get('results') or []:
  print('ROW', r.get('id'), r.get('companyName'), r.get('processingState'), r.get('publishedSubtype'))
PY
curl -s 'http://127.0.0.1:3000/api/sanita?includeAll=1' | python3 -c "import sys,json;j=json.load(sys.stdin);print('LIVE_N',len(j.get('data')or[]),'db', (j.get('meta')or{}).get('dbTotal'))"
echo enabled=$(systemctl is-enabled giorgio-revalidate)
echo active=$(systemctl is-active giorgio-revalidate || true)
ls /etc/systemd/system/giorgio-revalidate.service.d/
test ! -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf && echo NO_CANARY_DROPIN
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf || true
sha256sum /opt/leadsniper/prisma/dev.db
# control GET only
curl -s http://127.0.0.1:3000/api/sanita/archive-revalidation/control | python3 -m json.tool | head -30
# UI semantic probe via node? skip — just confirm run vs live
echo READY_READONLY_DONE
