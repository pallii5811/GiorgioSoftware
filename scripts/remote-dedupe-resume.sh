#!/usr/bin/env bash
set -uo pipefail
echo "=== STOP EVERYTHING (preserve checkpoint) ==="
systemctl stop giorgio-revalidate || true
pkill -f 'remote-pdf-priority' 2>/dev/null || true
pkill -f 'timeout 2400' 2>/dev/null || true
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 3
pgrep -af production-revalidate || echo stopped

python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
print("BEFORE", json.dumps({
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": list((cp.get("inProgress") or {}).keys()),
  "terminals": {k:v.get("processingState") for k,v in (cp.get("terminal") or {}).items()},
}, indent=2, ensure_ascii=False))
# move inProgress to retry due-now
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "dedupe_parents_after_probe",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
p.write_text(json.dumps(cp, indent=2))
print("AFTER", json.dumps({
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
}, indent=2))

# inspect newest terminal results
res=Path("/opt/leadsniper-revalidate/data/revalidation/results")
for tid, meta in (cp.get("terminal") or {}).items():
  row={}
  f=res/f"{tid}.json"
  if f.exists():
    try: row=json.loads(f.read_text())
    except: pass
  print("TERMINAL", tid, meta.get("processingState"), "reason", row.get("reasonCode"), "token", row.get("newVerdict"), "dual", bool(row.get("pass2")), "ev", ((row.get("fullEvidence") or "")[:160]))
PY

rm -f /opt/leadsniper-revalidate/data/revalidation/locks/*.lock 2>/dev/null || true
rm -f /opt/leadsniper-revalidate/app/data/revalidation/locks/*.lock 2>/dev/null || true

# Ensure unit is the safe @2 version with OUT_DIR
grep -E 'TOTAL_WORKERS|OUT_DIR|NODE_OPTIONS|REVALIDATE_LEAD' /etc/systemd/system/giorgio-revalidate.service || true
systemctl daemon-reload
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 10
systemctl is-active giorgio-revalidate
pgrep -c -f 'production-revalidate-sanita-v3' || true
pgrep -c -f 'production-revalidate-sanita-worker' || true
tail -n 30 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 30
free -h
