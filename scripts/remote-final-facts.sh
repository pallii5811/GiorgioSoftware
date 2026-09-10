#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json, urllib.request
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("REVAL", json.dumps({"done":len(cp.get("done") or {}),"stats":cp.get("stats"),"sha":cp.get("testedCodeSha")}, indent=2))
for path in ["/api/sanita?region=Campania","/api/gare"]:
  try:
    with urllib.request.urlopen("http://127.0.0.1:3000"+path, timeout=20) as r:
      j=json.load(r)
    meta=j.get("meta") or {}
    print(path, "success", j.get("success"), "data", len(j.get("data") or []), "actionable", meta.get("actionableCount", j.get("actionableCount")), "filtered", meta.get("filteredDefault", j.get("filteredDefault")))
  except Exception as e:
    print(path, "ERR", e)
print("BLUE_SHA", open("/opt/leadsniper/RELEASE_SHA").read().strip())
print("BACKUP_EXISTS", __import__("os").path.exists("/opt/leadsniper/backups/giorgio-live-20260720T165135Z.db"))
print("SYSTEMD", __import__("subprocess").check_output(["systemctl","is-active","giorgio-revalidate"], text=True).strip())
PY
