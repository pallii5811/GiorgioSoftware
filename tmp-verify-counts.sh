#!/bin/bash
set -euo pipefail
for q in \
  'region=Campania&includePending=1&includeAll=1' \
  'region=Campania&includeAll=1' \
  'region=all&includeAll=1' \
  'type=HEALTHCARE&includeAll=1'
do
  code=$(curl -s -o /tmp/a.json -w '%{http_code}' "http://127.0.0.1:3000/api/sanita?$q")
  python3 - <<PY
import json
from pathlib import Path
j=json.loads(Path('/tmp/a.json').read_text())
meta=j.get('meta') or {}
data=j.get('data') or j.get('leads') or []
print("$q", "http=$code", "returned", len(data), "dbTotal", meta.get('dbTotal'), "actionable", meta.get('actionableCount'), "filt", meta.get('filteredDefault'))
PY
done
# reference names
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
for name in ["Villa Dei Pini","Villa dei Fiori","Sant'Anna","Margherita"]:
  rows=c.execute("select companyName, city, type from Lead where companyName like ? limit 3", (f"%{name}%",)).fetchall()
  print(name, rows)
print('TOTAL', c.execute('select count(*) from Lead').fetchone()[0], 'HC', c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0])
PY
curl -s -o /dev/null -w 'ext:%{http_code}\n' --connect-timeout 5 "http://167.233.209.13:3000/api/sanita?region=Campania&includeAll=1" || true
