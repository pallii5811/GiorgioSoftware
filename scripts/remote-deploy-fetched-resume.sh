#!/usr/bin/env bash
# Deploy FETCHED-resume + frontier reuse + PUBLISHED_EXPIRED fix; preserve checkpoint.
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation

echo "=== GRACEFUL STOP ==="
systemctl stop giorgio-revalidate || true
for i in $(seq 1 60); do
  if ! pgrep -f 'production-revalidate-sanita' >/dev/null 2>&1; then break; fi
  sleep 2
done
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 2
pgrep -af production-revalidate || echo stopped

echo "=== DEPLOY ==="
cp -f /tmp/crawl-slice-runner.ts "$APP/src/lib/sanita/crawl-slice-runner.ts"
cp -f /tmp/production-revalidate-sanita-v3.mjs "$APP/scripts/"
cp -f /tmp/production-revalidate-sanita-worker.mjs "$APP/scripts/"
sha256sum "$APP/src/lib/sanita/crawl-slice-runner.ts" /tmp/crawl-slice-runner.ts
sha256sum "$APP/scripts/production-revalidate-sanita-v3.mjs" /tmp/production-revalidate-sanita-v3.mjs
sha256sum "$APP/scripts/production-revalidate-sanita-worker.mjs" /tmp/production-revalidate-sanita-worker.mjs

rm -f "$DATA/locks"/*.lock 2>/dev/null || true

python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
# inProgress -> retry due now (keep frontier paths)
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "deploy_fetched_resume",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
# Force cardio + pdf-heavy site due now for probe signal
force=["cmql4d390000oc9w70lelcqnp","cmqkld5s3009z108e1yj01zqy"]
for lid in force:
  if lid in (cp.get("terminal") or {}): continue
  meta=(cp.get("retryQueue") or {}).get(lid) or {"attempts": cp.get("attempts",{}).get(lid,1)}
  meta["nextRetryAt"]="1970-01-01T00:00:00.000Z"
  cp.setdefault("retryQueue",{})[lid]=meta
p.write_text(json.dumps(cp, indent=2))
print(json.dumps({"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"forced":force},indent=2))
PY

systemctl daemon-reload
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 15
echo "active=$(systemctl is-active giorgio-revalidate)"
pgrep -af 'flock.*revalidate.parent' | head -3
tail -n 25 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 25
python3 -c 'import json;cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print(json.dumps({"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"inProgress":list((cp.get("inProgress")or{}).keys())}))'
free -h | head -2
