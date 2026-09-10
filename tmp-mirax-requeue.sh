#!/bin/bash
set -euo pipefail
cd /home/worker/app/backend
set -a
source .env
set +a
python3 <<'PY'
import json, os, urllib.request
url=os.environ['SUPABASE_URL'].rstrip('/')
key=os.environ['SUPABASE_SERVICE_ROLE_KEY']

def req(path, method='GET', body=None):
    data=None if body is None else json.dumps(body).encode()
    headers={
        'apikey':key,
        'Authorization':f'Bearer {key}',
        'Content-Type':'application/json',
        'Prefer':'return=representation',
    }
    r=urllib.request.Request(f'{url}/rest/v1/{path}', data=data, method=method, headers=headers)
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw=resp.read().decode()
        return json.loads(raw) if raw else None

rows=req('searches?select=id,query,status,created_at,updated_at&order=created_at.desc&limit=20')
print('=== RECENT ===')
for r in rows or []:
    print(r.get('status'), (r.get('query') or '')[:60], r.get('id')[:8], r.get('created_at'))

# Requeue stuck non-pending/non-completed
stuck=[r for r in (rows or []) if str(r.get('status','')).lower() in {'running','processing','in_progress','claimed','error','failed'}]
print('STUCK', len(stuck))
for r in stuck[:10]:
    sid=r['id']
    out=req(f'searches?id=eq.{sid}', method='PATCH', body={'status':'pending'})
    print('REQUEUED', sid[:8], r.get('status'), '-> pending', bool(out))

pending=req('searches?select=id&status=eq.pending')
print('PENDING_NOW', len(pending or []))
PY
sleep 8
journalctl -u mirax-worker-user -n 15 --no-pager
