#!/usr/bin/env bash
set -euo pipefail
curl -sS -X POST http://127.0.0.1:3000/api/sanita/archive-revalidation/control \
  -H 'Content-Type: application/json' -d '{"action":"pause"}' || true
echo
pkill -f 'production-revalidate-sanita-v3' 2>/dev/null || true
pkill -f 'production-revalidate-sanita-worker' 2>/dev/null || true
pkill -f 'k3-micro-canary' 2>/dev/null || true
sleep 2
if pgrep -af 'production-revalidate-sanita|k3-micro-canary' | grep -v pgrep >/dev/null; then
  echo STILL_RUNNING
  pgrep -af 'production-revalidate-sanita|k3-micro' | grep -v pgrep || true
else
  echo STOPPED
fi
python3 - <<'PY'
import json
from pathlib import Path
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("inProgress", len(cp.get("inProgress") or {}))
print("terminal", len(cp.get("terminal") or {}))
print("stats", cp.get("stats"))
rel=Path("/opt/leadsniper/RELEASE_SHA")
print("RELEASE", rel.read_text().strip() if rel.exists() else None)
PY
