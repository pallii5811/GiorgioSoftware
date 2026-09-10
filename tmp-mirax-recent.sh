#!/bin/bash
set -euo pipefail
cd /home/worker/app/backend
set -a; source ./.env; set +a
curl -sS "${SUPABASE_URL}/rest/v1/searches?select=id,status,category,location,created_at&order=created_at.desc&limit=10" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
echo
journalctl -u mirax-worker-user -n 12 --no-pager
