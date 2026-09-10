#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json, os, subprocess
cp='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
j=json.load(open(cp)) if os.path.exists(cp) else {}
print(json.dumps({
  "done": len(j.get("done",{})),
  "stats": j.get("stats"),
  "testedCodeSha": j.get("testedCodeSha"),
  "blueSha": open("/opt/leadsniper/RELEASE_SHA").read().strip() if os.path.exists("/opt/leadsniper/RELEASE_SHA") else None,
}, indent=2))
PY
curl -sf --max-time 20 "http://127.0.0.1:3000/api/sanita?region=Campania" | python3 -c "import sys,json; j=json.load(sys.stdin); print('campania_returned', len(j.get('data') or []))"
