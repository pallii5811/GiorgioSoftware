#!/bin/bash
set -euo pipefail
cd /home/worker/app/backend
set -a; source ./.env; set +a
# status distribution
curl -sS "$SUPABASE_URL/rest/v1/searches?select=status" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Accept: application/json" -o /tmp/all_status.json
python3 - <<'PY'
import json,collections
rows=json.load(open('/tmp/all_status.json'))
c=collections.Counter(r.get('status') for r in rows)
print('STATUS_COUNTS', dict(c), 'N', len(rows))
PY
# newest with category/location
curl -sS "$SUPABASE_URL/rest/v1/searches?select=id,status,category,location,created_at&order=created_at.desc&limit=30" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -o /tmp/recent.json
python3 - <<'PY'
import json
rows=json.load(open('/tmp/recent.json'))
for r in rows:
  print(r.get('created_at'), r.get('status'), (r.get('category') or '')[:40], (r.get('location') or '')[:30], r['id'][:8])
PY
