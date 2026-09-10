#!/usr/bin/env bash
set -euo pipefail
install -m 644 /tmp/revalidate-checkpoint-v3.mjs /opt/leadsniper-revalidate/app/scripts/revalidate-checkpoint-v3.mjs
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': len(cp.get('inProgress') or {}),
  'review': sum(1 for v in (cp.get('terminal') or {}).values() if v.get('processingState')=='REVIEW_HUMAN'),
}, indent=2))
PY
