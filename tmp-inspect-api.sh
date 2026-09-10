#!/bin/bash
set -euo pipefail
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' -o /tmp/run.json
curl -s 'http://127.0.0.1:3000/api/sanita?includeAll=1' -o /tmp/live.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/run.json'))
print('RUN', j.get('success'), 'n', len(j.get('results') or []), 'meta', j.get('meta'))
j=json.load(open('/tmp/live.json'))
print('LIVE', len(j.get('data') or []), 'dbTotal', (j.get('meta') or {}).get('dbTotal'))
PY
command -v tesseract || true
ls /usr/bin/tesseract* 2>/dev/null || true
dpkg -l | grep -i tesseract | head || true
find /opt/leadsniper-revalidate/app -name 'tesseract*' 2>/dev/null | head
grep -n APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service || echo NO_APPLY_LIVE
