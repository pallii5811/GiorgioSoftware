#!/bin/bash
# Poll until first canary terminal/result or 12 min
set -euo pipefail
for i in $(seq 1 24); do
  python3 - <<'PY'
import json, time
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
res=len(list(Path('/opt/leadsniper-revalidate/data/revalidation/results').glob('*.json')))
term=len(cp.get('terminal') or {})
ip=len(cp.get('inProgress') or {})
print(time.strftime('%H:%M:%S'), 'term', term, 'res', res, 'ip', ip, 'active', flush=True)
open('/tmp/canary_watch.txt','a').write(f'{term} {res} {ip}\n')
raise SystemExit(0 if (term>=1 or res>=1) else 1)
PY
  rc=$?
  if [[ $rc -eq 0 ]]; then echo GOT_RESULT; exit 0; fi
  sleep 30
done
echo TIMEOUT
exit 1
