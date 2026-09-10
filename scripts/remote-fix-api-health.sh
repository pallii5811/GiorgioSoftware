#!/usr/bin/env bash
set -uo pipefail
curl -sS --max-time 15 "http://127.0.0.1:3000/api/sanita?region=Campania" -o /tmp/s.json -w "http=%{http_code}\n"
python3 - <<'PY'
import json
j=json.load(open("/tmp/s.json"))
print(json.dumps({k:j.get(k) for k in ("success","count","actionableCount","totalReturned","filteredDefault","actionableQueueRequireCurrentEvidence")}, indent=2))
print("data_len", len(j.get("data") or []))
PY
pm2 describe leadsniper-ui | head -40
cat /opt/leadsniper/RELEASE_SHA
# rebuild if next missing build id match
cd /opt/leadsniper
if [ ! -f .next/BUILD_ID ]; then echo MISSING_BUILD; npm run build; pm2 restart leadsniper-ui --update-env; fi
ls -la .next/BUILD_ID 2>/dev/null || true
