#!/usr/bin/env bash
set -uo pipefail
systemctl is-active giorgio-revalidate || true
python3 - <<'PY'
import json, os
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
res=len([f for f in os.listdir("/opt/leadsniper-revalidate/data/revalidation/results") if f.endswith(".json") and ".p" not in f])
print(json.dumps({
  "version": cp.get("version"),
  "terminal": len(cp.get("terminal") or {}),
  "retryQueue": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
  "attempts_sample": list((cp.get("attempts") or {}).items())[:5],
  "stats": cp.get("stats"),
  "results": res,
  "sha": cp.get("testedCodeSha"),
  "updated": cp.get("updatedAt"),
}, indent=2))
PY
pgrep -c -f 'production-revalidate-sanita-worker' || echo workers=0
pgrep -c -f 'production-revalidate-sanita-v3' || echo parent=0
tail -n 15 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 15
free -m | head -2
