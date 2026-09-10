#!/bin/bash
set -euo pipefail
cd /opt/leadsniper
python3 <<'PY'
import json, urllib.request, sqlite3
# DB refs
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
for q in ["%Villa Dei Pini%","%Malzoni%"]:
  rows=c.execute(
    "select id, companyName, city, status, substr(evidence,1,100), lastScannedAt from Lead where companyName like ?",
    (q,),
  ).fetchall()
  print('DB', q, len(rows))
  for r in rows[:3]:
    print(' ', r[1], r[2], 'ev', r[4][:70])

# API refs
with urllib.request.urlopen('http://127.0.0.1:3000/api/sanita?includeAll=1', timeout=60) as r:
  j=json.loads(r.read())
data=j.get('data') or []
print('API_N', len(data), 'dbTotal', (j.get('meta') or {}).get('dbTotal'))
for needle in ['Villa Dei Pini', 'Malzoni']:
  hits=[x for x in data if needle.lower() in (x.get('companyName') or '').lower()]
  print('API', needle, len(hits))
  for h in hits[:2]:
    sem=h.get('semantic') or {}
    print(' ', h['companyName'], 'token', sem.get('verdictToken'), 'actionable', sem.get('actionable'), 'label', (sem.get('clientLabel') or '')[:60])

# service still off
import subprocess
print('revalidate', subprocess.check_output(['systemctl','is-active','giorgio-revalidate'], text=True).strip())
print('RELEASE', open('RELEASE_SHA').read().strip())
PY
# vercel via engine outbound
curl -sS --connect-timeout 30 -o /tmp/vercel.json -w "vercel_http:%{http_code} size:%{size_download}\n" \
  "https://giorgio-software.vercel.app/api/sanita?includeAll=1" || true
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/tmp/vercel.json')
if p.exists() and p.stat().st_size>100:
  j=json.loads(p.read_text())
  d=j.get('data') or []
  print({'vercel_n':len(d),'dbTotal':(j.get('meta') or {}).get('dbTotal')})
else:
  print('vercel_empty_or_fail', p.stat().st_size if p.exists() else None)
PY
