#!/usr/bin/env bash
set -uo pipefail
systemctl is-active giorgio-revalidate || true
python3 - <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print(json.dumps({
  "done": len(cp.get("done") or {}),
  "stats": cp.get("stats"),
  "updated": cp.get("updatedAt"),
  "sha": cp.get("testedCodeSha"),
}, indent=2))
PY
tail -n 5 /opt/leadsniper-revalidate/logs/systemd-revalidate.log || true
free -m | head -2
curl -sf "http://127.0.0.1:3000/api/sanita?region=Campania" | python3 -c 'import sys,json; j=json.load(sys.stdin); print("campania", j.get("actionableCount"), j.get("filteredDefault"), open("/opt/leadsniper/RELEASE_SHA").read().strip())'
ls /opt/leadsniper-revalidate/data/revalidation/results | wc -l
