#!/usr/bin/env bash
set -uo pipefail
# Quick integrity of latest recovery snapshot + current cp
SNAP=$(ls -1dt /opt/leadsniper-revalidate/snapshots/recovery-* | head -1)
echo "SNAP=$SNAP"
cat "$SNAP/SNAPSHOT_META.json"
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
term=cp.get("terminal") or {}
by={}
for v in term.values():
  by[v.get("processingState")]=by.get(v.get("processingState"),0)+1
print(json.dumps({
  "version": cp.get("version"),
  "terminal_total": len(term),
  "terminal_by_state": by,
  "retryQueue": len(cp.get("retryQueue") or {}),
  "inProgress": list((cp.get("inProgress") or {}).keys()),
  "updatedAt": cp.get("updatedAt"),
  "testedCodeSha": cp.get("testedCodeSha"),
}, indent=2))
PY
curl -sS --max-time 15 "http://127.0.0.1:3000/api/sanita?region=Campania" | python3 -c 'import sys,json; j=json.load(sys.stdin); m=j.get("meta") or {}; print("sanita", m.get("actionableCount"), m.get("filteredDefault"), m.get("actionableQueueRequireCurrentEvidence"))'
curl -sS --max-time 15 "http://127.0.0.1:3000/api/gare" | python3 -c 'import sys,json; j=json.load(sys.stdin); m=j.get("meta") or {}; print("gare", m.get("actionableCount"), m.get("filteredDefault"), "data", len(j.get("data") or []))'
echo SHA_BLUE=$(cat /opt/leadsniper/RELEASE_SHA)
echo SNAPSHOT=$(ls -1dt /opt/leadsniper-revalidate/snapshots/recovery-* | head -1)
