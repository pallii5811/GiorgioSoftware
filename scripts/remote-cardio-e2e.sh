#!/usr/bin/env bash
# Isolated CardioProgress revalidate with patched worker; preserve checkpoint otherwise.
set -uo pipefail
WORKDIR=/opt/leadsniper-revalidate
APP=$WORKDIR/app
DATA=$WORKDIR/data/revalidation
CARDIO=cmql4d390000oc9w70lelcqnp

systemctl stop giorgio-revalidate || true
pkill -f 'production-revalidate-sanita' 2>/dev/null || true
pkill -f 'chrome-headless-shell' 2>/dev/null || true
sleep 2
rm -f "$DATA/locks"/*.lock 2>/dev/null || true

python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone
p=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(p.read_text())
now=datetime.now(timezone.utc).isoformat()
CARDIO="cmql4d390000oc9w70lelcqnp"
# inProgress → retry
for lid, meta in list((cp.get("inProgress") or {}).items()):
  if lid not in (cp.get("terminal") or {}):
    prev=(cp.get("retryQueue") or {}).get(lid) or {}
    cp.setdefault("retryQueue", {})[lid]={
      "attempts": prev.get("attempts") or (cp.get("attempts") or {}).get(lid, 1),
      "lastReason": "IN_PROGRESS_INTERRUPTED",
      "lastError": "cardio_priority_probe",
      "nextRetryAt": "1970-01-01T00:00:00.000Z",
      "lastRunId": (meta or {}).get("runId") or prev.get("lastRunId"),
      "frontierPath": (meta or {}).get("frontierPath") or prev.get("frontierPath"),
      "firstSeenAt": prev.get("firstSeenAt") or now,
      "lastAttemptAt": now,
    }
  del cp["inProgress"][lid]
# ensure cardio in retry due now, not terminal
cp.get("terminal", {}).pop(CARDIO, None)
cp.setdefault("retryQueue", {})[CARDIO]={
  **((cp.get("retryQueue") or {}).get(CARDIO) or {}),
  "attempts": (cp.get("retryQueue") or {}).get(CARDIO, {}).get("attempts") or 1,
  "lastReason": "PUBLISHED_QUARANTINE_REGEX_INVENTION",
  "lastError": "cardio_e2e_revalidate",
  "nextRetryAt": "1970-01-01T00:00:00.000Z",
  "lastAttemptAt": now,
}
p.write_text(json.dumps(cp, indent=2))
print("ready_cardio", CARDIO, "terminal", len(cp.get("terminal") or {}), "retry", len(cp.get("retryQueue") or {}))
PY

cd "$APP"
export GIT_HEAD=$(cat RELEASE_SHA) RELEASE_SHA=$(cat RELEASE_SHA)
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true
export TOTAL_WORKERS=1 REVALIDATE_CONCURRENCY=1 REVALIDATE_DUAL_HOT=1
export REVALIDATE_CHECKPOINT=$DATA/checkpoint.json
export REVALIDATE_OUT_DIR=$DATA
export TESSDATA_PREFIX=$APP/.tesseract-cache
export PDFTOPPM_PATH=$(command -v pdftoppm)
export CRAWL_HTML_URL_CAP=40
export CRAWL_RUN_MAX_WALL_CLOCK_MS=1800000
export CRAWL_MAX_HTML_PER_SLICE=12
export PER_HOST_CONCURRENCY=1
export REVALIDATE_LEAD_WALL_MS=1800000
export NODE_OPTIONS=--max-old-space-size=3072
export REVALIDATE_IDS="$CARDIO"
LOG=$WORKDIR/logs/cardio-e2e-$(date -u +%Y%m%dT%H%M%SZ).log
echo "=== CARDIO E2E ==="
timeout 2400 npx tsx scripts/production-revalidate-sanita-v3.mjs >"$LOG" 2>&1 || echo "exit=$?"
tail -n 40 "$LOG" | tr -d '\000'
python3 - <<'PY'
import json
from pathlib import Path
CARDIO="cmql4d390000oc9w70lelcqnp"
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
r=json.loads(Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{CARDIO}.json").read_text())
print("CARDIO_E2E_RESULT")
print(json.dumps({
  "checkpoint_terminal_entry": (cp.get("terminal") or {}).get(CARDIO),
  "checkpoint_retry_entry": {k:(cp.get("retryQueue") or {}).get(CARDIO,{}).get(k) for k in ("attempts","lastReason","nextRetryAt","lastError")} if CARDIO in (cp.get("retryQueue") or {}) else None,
  "result": {
    "processingState": r.get("processingState"),
    "reasonCode": r.get("reasonCode"),
    "newVerdict": r.get("newVerdict"),
    "token": r.get("token"),
    "businessVerdict": r.get("businessVerdict"),
    "policyFound": r.get("policyFound"),
    "policyExpiry": r.get("policyExpiry"),
    "wallMs": r.get("wallMs") or (r.get("pass1") or {}).get("wallMs"),
    "evidence_head": (r.get("fullEvidence") or "")[:320],
  },
  "cp_counts": {"terminal": len(cp.get("terminal") or {}), "retry": len(cp.get("retryQueue") or {}), "inProgress": len(cp.get("inProgress") or {})},
  "forged_pub": str(r.get("processingState") or "").startswith("PUBLISHED") and (r.get("token") or r.get("newVerdict")) == "HOT",
}, indent=2, ensure_ascii=False))
PY

rm -f "$DATA/locks"/*.lock /opt/leadsniper-revalidate/revalidate.parent.lock 2>/dev/null || true
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 8
systemctl is-active giorgio-revalidate
python3 -c 'import json;cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print(json.dumps({"terminal":len(cp.get("terminal")or{}),"retry":len(cp.get("retryQueue")or{}),"inProgress":len(cp.get("inProgress")or{}),"pubs":[k for k,v in (cp.get("terminal")or{}).items() if str(v.get("processingState","")).startswith("PUBLISHED")]}))'
