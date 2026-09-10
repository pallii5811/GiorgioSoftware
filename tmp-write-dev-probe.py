#!/usr/bin/env python3
"""Check Dev supabase for today's searches using Dev .env.local keys — run LOCALLY writing a remote script without secrets in repo."""
from pathlib import Path
import json

def kv(text):
    d={}
    for line in text.splitlines():
        s=line.strip()
        if not s or s.startswith('#') or '=' not in s: continue
        k,v=s.split('=',1); d[k.strip()]=v.strip().strip('"').strip("'")
    return d

dev=kv(Path(r'c:\Users\Simone\CascadeProjects\WEB APP CKB - Dev\.env.local').read_text(encoding='utf-8-sig'))
# Write remote probe script with embedded secrets (server /tmp only)
script=f'''#!/bin/bash
set -euo pipefail
URL="{dev['NEXT_PUBLIC_SUPABASE_URL']}"
KEY="{dev['SUPABASE_SERVICE_ROLE_KEY']}"
curl -sS "$URL/rest/v1/searches?select=id,status,category,location,created_at&order=created_at.desc&limit=20" \\
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -o /tmp/dev_searches.json
python3 - <<'PY'
import json,collections
rows=json.load(open('/tmp/dev_searches.json'))
print('DEV_N', len(rows))
c=collections.Counter(r.get('status') for r in rows)
print('DEV_STATUS', dict(c))
for r in rows:
  print(r.get('created_at'), r.get('status'), (r.get('category') or '')[:50], (r.get('location') or '')[:30], r['id'][:8])
PY
# pending count
curl -sS "$URL/rest/v1/searches?select=id&status=eq.pending" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -o /tmp/dev_pending.json
python3 -c "import json; print('DEV_PENDING', len(json.load(open('/tmp/dev_pending.json'))))"
'''
Path(r'c:\Users\Simone\AppData\Local\Temp\mirax-probe-dev-sb.sh').write_text(script.replace('\r\n','\n'), encoding='utf-8')
print('wrote probe')
