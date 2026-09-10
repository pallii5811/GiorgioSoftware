#!/bin/bash
set -euo pipefail
python3 - <<'PY'
import json
from pathlib import Path
root=Path('/opt/leadsniper-revalidate/data/revalidation/results')
for p in sorted(root.glob('*.json')):
  if '.p' in p.name: continue
  j=json.loads(p.read_text(encoding='utf-8'))
  ps=j.get('processingState')
  ev=(j.get('evidence') or '')[:200]
  print('---', p.name)
  print('ps', ps, 'verdict', j.get('newVerdict'), 'reason', j.get('reasonCode'))
  print('ev', ev.replace('\n',' ')[:180])
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('TERMINAL', cp.get('terminal'))
print('RETRY', list((cp.get('retryQueue') or {})).keys())
print('IP', list((cp.get('inProgress') or {})).keys())
PY
echo '---API---'
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' | python3 -c "import sys,json;j=json.load(sys.stdin);print('run_n',len(j.get('results')or[]));
[print(r.get('id'), r.get('processingState') or r.get('publishedSubtype')) for r in (j.get('results')or[])[:5]]"
curl -s 'http://127.0.0.1:3000/api/sanita?includeAll=1' | python3 -c "import sys,json;j=json.load(sys.stdin);print('live',len(j.get('data')or[]))"
echo enabled=$(systemctl is-enabled giorgio-revalidate)
echo active=$(systemctl is-active giorgio-revalidate || true)
ls /etc/systemd/system/giorgio-revalidate.service.d/
# control duplicate test while paused then start/stop
curl -s -X POST http://127.0.0.1:3000/api/sanita/archive-revalidation/control -H 'Content-Type: application/json' -d '{"action":"start"}' | python3 -m json.tool | head -20
sleep 3
curl -s http://127.0.0.1:3000/api/sanita/archive-revalidation/control | python3 -c "import sys,json;j=json.load(sys.stdin);print('active1',j.get('active'),j.get('systemdActive'))"
curl -s -X POST http://127.0.0.1:3000/api/sanita/archive-revalidation/control -H 'Content-Type: application/json' -d '{"action":"start"}' | python3 -m json.tool | head -20
sleep 2
curl -s -X POST http://127.0.0.1:3000/api/sanita/archive-revalidation/control -H 'Content-Type: application/json' -d '{"action":"pause"}' | python3 -m json.tool | head -20
sleep 2
echo FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)
sha256sum /opt/leadsniper/prisma/dev.db
# ensure no canary id restriction
test ! -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf && echo NO_CANARY_DROPIN
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
