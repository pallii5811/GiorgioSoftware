#!/usr/bin/env bash
# Clear orphaned inProgress after graceful stop — do NOT touch terminal/retryQueue/results.
set -euo pipefail
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
python3 <<'PY'
import json, shutil, time
cp_path="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
shutil.copy2(cp_path, cp_path+f".bak-clear-inprogress-{int(time.time())}")
cp=json.load(open(cp_path))
ip=cp.get("inProgress") or {}
print("inProgress_before", list(ip.keys()))
cp["inProgress"]={}
cp["updatedAt"]=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
# atomic write
tmp=cp_path+".tmp"
open(tmp,"w").write(json.dumps(cp, indent=2))
shutil.move(tmp, cp_path)
print("inProgress_after", list((cp.get("inProgress") or {}).keys()))
print("terminal", len(cp.get("terminal") or {}))
print("retry", len(cp.get("retryQueue") or {}))
PY
sha256sum "$CP"
echo "CLEAR_INPROGRESS_OK"
