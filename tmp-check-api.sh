#!/bin/bash
set -euo pipefail
curl -s "http://127.0.0.1:3000/api/sanita?region=Campania&includePending=1" -o /tmp/api.json
python3 <<'PY'
import json, sqlite3
from pathlib import Path
raw=Path('/tmp/api.json').read_text(encoding='utf-8')
print('api_bytes', len(raw))
print('api_head', raw[:500])
j=json.loads(raw)
print('top_keys', list(j.keys()) if isinstance(j, dict) else type(j))
for k in ('leads','data','count','total','error','items'):
  if isinstance(j, dict) and k in j:
    v=j[k]
    print(k, type(v).__name__, (len(v) if hasattr(v,'__len__') and not isinstance(v,str) else v))
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
print('db_leads', c.execute('select count(*) from Lead').fetchone()[0])
print('db_hc', c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0])
PY
pm2 show leadsniper-ui | head -40
echo '---env---'
grep -E '^[A-Z_]+=' /opt/leadsniper/.env | cut -d= -f1
