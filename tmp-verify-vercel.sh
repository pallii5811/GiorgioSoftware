#!/bin/bash
set -e
sleep 2
curl -sS --connect-timeout 25 -o /tmp/v.json -w "http:%{http_code} size:%{size_download}\n" \
  "https://giorgio-software.vercel.app/api/sanita?includeAll=1" || true
python3 <<'PY'
import json
from pathlib import Path
p=Path('/tmp/v.json')
if not p.exists() or p.stat().st_size==0:
  print('EMPTY')
  raise SystemExit(1)
j=json.loads(p.read_text())
d=j.get('data') or []
m=j.get('meta') or {}
print({'n':len(d),'dbTotal':m.get('dbTotal'),'error':j.get('error'),'success':j.get('success')})
PY
