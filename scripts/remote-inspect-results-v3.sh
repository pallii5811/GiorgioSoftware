#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json, os, glob
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
term=cp.get("terminal") or {}
print("TERMINAL", json.dumps(term, indent=2)[:2000])
# sample newest results
files=sorted(glob.glob("/opt/leadsniper-revalidate/data/revalidation/results/*.json"), key=os.path.getmtime, reverse=True)
for f in files[:3]:
  if ".p1." in f or ".p2." in f or ".tmp" in f: continue
  r=json.load(open(f))
  print(json.dumps({
    "file": os.path.basename(f),
    "ps": r.get("processingState"),
    "hasFull": isinstance(r.get("fullEvidence"), str) and len(r.get("fullEvidence") or "")>0,
    "fullLen": len(r.get("fullEvidence") or ""),
    "schema": r.get("schemaVersion"),
    "dual": r.get("dualDisagreement"),
    "pass2": bool(r.get("pass2")),
  }, indent=2))
print(json.dumps({
  "terminal": len(term),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
  "concurrency_hint": "see metrics",
}, indent=2))
PY
systemctl is-active giorgio-revalidate
pgrep -c -f 'production-revalidate-sanita-worker' || true
