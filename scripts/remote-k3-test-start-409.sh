#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json, urllib.request
req = urllib.request.Request(
  "http://127.0.0.1:3000/api/sanita/archive-revalidation/control",
  data=json.dumps({"action": "start"}).encode(),
  headers={"Content-Type": "application/json"},
  method="POST",
)
try:
  with urllib.request.urlopen(req, timeout=20) as r:
    print("status", r.status)
    print(r.read().decode()[:500])
except urllib.error.HTTPError as e:
  print("status", e.code)
  print(e.read().decode()[:500])
PY
