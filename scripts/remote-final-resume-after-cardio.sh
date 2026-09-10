#!/usr/bin/env bash
set -uo pipefail
# Ensure cardio e2e leftover stopped; service up; final counts
pkill -f 'timeout 2400 npx tsx scripts/production-revalidate' 2>/dev/null || true
pkill -f 'REVALIDATE_IDS=cmql4d390000oc9w70lelcqnp' 2>/dev/null || true
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
sleep 2
rm -f /opt/leadsniper-revalidate/data/revalidation/locks/*.lock 2>/dev/null || true
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock 2>/dev/null || true
# clear inProgress if any
python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or 1,
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "post_cardio_resume",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
# assert no PUB in terminal
pubs=[k for k,v in (cp.get("terminal") or {}).items() if str(v.get("processingState","")).startswith("PUBLISHED")]
assert not pubs, pubs
p.write_text(json.dumps(cp, indent=2))
print(json.dumps({"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"inProgress":0,"pubs_in_terminal":pubs,"cardio":(cp.get("retryQueue")or{}).get("cmql4d390000oc9w70lelcqnp")}, indent=2, default=str))
PY
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 8
systemctl is-active giorgio-revalidate
pgrep -af 'flock.*revalidate.parent' | head -2
python3 - <<'PY'
import json
from pathlib import Path
r=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/results/cmql4d390000oc9w70lelcqnp.json").read_text())
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print("FINAL")
print(json.dumps({
  "cardio_result": {
    "processingState": r.get("processingState"),
    "reasonCode": r.get("reasonCode"),
    "token": r.get("token"),
    "newVerdict": r.get("newVerdict"),
    "businessVerdict": r.get("businessVerdict"),
    "wallMs": r.get("wallMs") or (r.get("pass1") or {}).get("wallMs"),
  },
  "invented_published": str(r.get("processingState","")).startswith("PUBLISHED"),
  "checkpoint": {
    "terminal": len(cp.get("terminal") or {}),
    "retry": len(cp.get("retryQueue") or {}),
    "inProgress": len(cp.get("inProgress") or {}),
    "by_state": {k: sum(1 for v in (cp.get("terminal") or {}).values() if v.get("processingState")==k) for k in sorted({v.get("processingState") for v in (cp.get("terminal") or {}).values()})},
  },
  "sha256": {
    "worker": __import__("hashlib").sha256(Path("/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs").read_bytes()).hexdigest(),
    "canonical": __import__("hashlib").sha256(Path("/opt/leadsniper-revalidate/app/src/lib/sanita/canonical-published-terminal.ts").read_bytes()).hexdigest(),
    "scan_engine": __import__("hashlib").sha256(Path("/opt/leadsniper-revalidate/app/src/lib/sanita/scan-engine.ts").read_bytes()).hexdigest(),
  }
}, indent=2))
PY
