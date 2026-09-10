#!/usr/bin/env bash
# Graceful stop of giorgio-revalidate parent only — preserve checkpoint/results/frontiers.
set -euo pipefail
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
SNAP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.pre-published-priority-$(date -u +%Y%m%dT%H%M%SZ).json
echo "REVAL_BEFORE=$(systemctl is-active giorgio-revalidate || true)"
sha256sum "$CP" | tee /tmp/cp-before-priority-stop.sha
cp -a "$CP" "$SNAP"
echo "SNAPSHOT=$SNAP"
# SIGTERM → parent sets stopping=true, finishes in-flight, saves checkpoint
systemctl kill -s SIGTERM giorgio-revalidate || true
for i in $(seq 1 90); do
  st=$(systemctl is-active giorgio-revalidate || true)
  if [ "$st" != "active" ]; then
    echo "STOPPED_AFTER=${i}s status=$st"
    break
  fi
  sleep 2
done
# If still active after ~3min, stop unit (still SIGTERM first via systemd)
if systemctl is-active --quiet giorgio-revalidate; then
  echo "STILL_ACTIVE_FORCE_STOP"
  systemctl stop giorgio-revalidate
fi
sleep 2
echo "REVAL_AFTER=$(systemctl is-active giorgio-revalidate || true)"
sha256sum "$CP" | tee /tmp/cp-after-priority-stop.sha
python3 <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print(json.dumps({
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
  "stats": cp.get("stats"),
  "updatedAt": cp.get("updatedAt"),
}, indent=2))
PY
echo "STOP_OK"
