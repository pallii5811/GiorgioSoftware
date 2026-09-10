#!/usr/bin/env bash
set -uo pipefail
CARDIO=cmql4d390000oc9w70lelcqnp
echo "=== SERVICE ==="
systemctl is-active giorgio-revalidate
echo "=== CP ==="
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print(json.dumps({
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": list((cp.get("inProgress") or {}).keys()),
  "cardio_terminal": (cp.get("terminal") or {}).get("cmql4d390000oc9w70lelcqnp"),
  "cardio_retry": (cp.get("retryQueue") or {}).get("cmql4d390000oc9w70lelcqnp"),
  "pubs_in_terminal": {k:v.get("processingState") for k,v in (cp.get("terminal") or {}).items() if str(v.get("processingState","")).startswith("PUBLISHED")},
}, indent=2, default=str))
PY
echo "=== CARDIO RESULT ==="
python3 - <<'PY'
import json
from pathlib import Path
p=Path("/opt/leadsniper-revalidate/data/revalidation/results/cmql4d390000oc9w70lelcqnp.json")
if p.exists():
  r=json.loads(p.read_text())
  print(json.dumps({
    "processingState": r.get("processingState"),
    "reasonCode": r.get("reasonCode"),
    "newVerdict": r.get("newVerdict"),
    "token": r.get("token"),
    "businessVerdict": r.get("businessVerdict"),
    "policyFound": r.get("policyFound"),
    "policyExpiry": r.get("policyExpiry"),
    "wallMs": r.get("wallMs") or (r.get("pass1") or {}).get("wallMs"),
    "finishedAt": r.get("finishedAt"),
    "evidence_head": (r.get("fullEvidence") or "")[:280],
  }, indent=2, ensure_ascii=False))
else:
  print("no_result_yet")
PY
echo "=== HASH ==="
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs /opt/leadsniper-revalidate/app/src/lib/sanita/canonical-published-terminal.ts /opt/leadsniper-revalidate/app/src/lib/sanita/scan-engine.ts
grep -a 'lead_done.*cmql4d390000oc9w70lelcqnp\|worker_done.*cmql4d390000oc9w70lelcqnp\|frontier_resume.*cmql4d390000oc9w70lelcqnp' /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 10
