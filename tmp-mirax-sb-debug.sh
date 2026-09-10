#!/bin/bash
set -euo pipefail
cd /home/worker/app/backend
set -a
# shellcheck disable=SC1091
source ./.env
set +a
echo "URL=$SUPABASE_URL"
curl -sS -o /tmp/sb.json -w "http=%{http_code}\n" \
  "$SUPABASE_URL/rest/v1/searches?select=id,status,created_at&order=created_at.desc&limit=10" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Accept: application/json"
head -c 800 /tmp/sb.json; echo
# try with query column
curl -sS -o /tmp/sb2.json -w "http2=%{http_code}\n" \
  "$SUPABASE_URL/rest/v1/searches?select=*&order=created_at.desc&limit=3" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
python3 - <<'PY'
import json
from pathlib import Path
for name in ('/tmp/sb.json','/tmp/sb2.json'):
  t=Path(name).read_text(encoding='utf-8', errors='replace')
  print('FILE', name, 'len', len(t))
  print(t[:500])
PY
journalctl -u mirax-worker-user -n 20 --no-pager
curl -sf http://127.0.0.1:8001/health; echo
