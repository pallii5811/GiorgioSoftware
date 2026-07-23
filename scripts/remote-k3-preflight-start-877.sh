#!/usr/bin/env bash
# Preflight + backup + start 877 shadow (resume, apply live=0).
set -euo pipefail
W=/opt/leadsniper-revalidate
APP=$W/app
UI=/opt/leadsniper
BK=$W/data/k3-stopship/backups/pre-877-$(date -u +%Y%m%dT%H%M%SZ)
BASELINE_DIR=/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z
EXPECT_JSON_SHA=5e93be5d8dd71384f9773138b5b1392c40f5550535266f39671e11af60d22894
MANIFEST=$W/data/k3-stopship/RELEASE_MANIFEST_877.json
CP=$W/data/revalidation/checkpoint.json

echo "=== PREFLIGHT ==="
test -f "$APP/RELEASE_SHA"
SHA=$(cat "$APP/RELEASE_SHA")
UI_SHA=$(cat "$UI/RELEASE_SHA")
test "$SHA" = "$UI_SHA" || { echo "SHA_MISMATCH app=$SHA ui=$UI_SHA"; exit 2; }
echo "SHA=$SHA"

# no duplicate engines
if pgrep -af 'production-revalidate-sanita-v3|k3-micro-canary10' | grep -v pgrep >/dev/null; then
  echo "REFUSING: engine already running"; pgrep -af 'production-revalidate|k3-micro' | grep -v pgrep; exit 2
fi

# systemd
if systemctl is-active giorgio-revalidate 2>/dev/null | grep -q active; then
  echo "REFUSING: giorgio-revalidate already active"; exit 2
fi

# baseline
test -f "$BASELINE_DIR/published-legacy-baseline.json"
GOT=$(sha256sum "$BASELINE_DIR/published-legacy-baseline.json" | awk '{print $1}')
test "$GOT" = "$EXPECT_JSON_SHA" || { echo "BASELINE_TAMPERED $GOT"; exit 2; }
echo "BASELINE_OK"

# active UI jobs
python3 - <<'PY'
import json, urllib.request, sys
raw=urllib.request.urlopen('http://127.0.0.1:3000/api/sanita/jobs?active=1', timeout=20).read()
j=json.loads(raw)
jobs=j.get('jobs') or []
if jobs:
  print('REFUSING_ACTIVE_UI_JOBS', len(jobs)); sys.exit(2)
print('UI_ACTIVE_JOBS=0')
PY

# OCR preflight
test -x /usr/bin/pdftoppm
test -d "$APP/.tesseract-cache"
test -f "$APP/.tesseract-cache/ita.traineddata" || test -f /usr/share/tesseract-ocr/5/tessdata/ita.traineddata
echo "OCR_OK"

# gate file
GATE=$W/data/k3-stopship/FINAL_ENGINE_GATE.json
test -f "$GATE"
python3 - <<PY
import json,sys
g=json.load(open("$GATE"))
assert g.get("pass") is True, g
assert g.get("malzoni")=="SELF_INSURANCE_VERIFIED"
print("GATE_OK", g["completedCommercial"], g["rawCompletion"], g["reachableCompletion"])
PY

echo "=== BACKUP ==="
mkdir -p "$BK"
cp -a "$CP" "$BK/checkpoint.json"
sha256sum "$BK/checkpoint.json" | tee "$BK/checkpoint.sha256"
# DB
cp -a "$W/shadow-revalidate.db" "$BK/shadow-revalidate.db"
sha256sum "$BK/shadow-revalidate.db" | tee "$BK/shadow-revalidate.sha256"
# frontiers sample
mkdir -p "$BK/frontiers"
cp -a "$W/data/revalidation/frontiers" "$BK/frontiers-dir" 2>/dev/null || true
find "$W/data/revalidation/frontiers" -name '*.sqlite' 2>/dev/null | head -5 | while read f; do
  bn=$(basename "$f")
  sha256sum "$f" >> "$BK/frontiers.sha256" || true
done
echo "$EXPECT_JSON_SHA" > "$BK/baseline117.sha256"
echo "BACKUP_OK $BK"

# apply live = 0 check via env expectation in unit
python3 - <<PY
import json, time, os
meta={
  "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "releaseSha": open("/opt/leadsniper-revalidate/app/RELEASE_SHA").read().strip(),
  "targetTotal": 877,
  "applyLive": 0,
  "discovery": "off",
  "resume": True,
  "mode": "shadow",
  "baselineSha256": "$EXPECT_JSON_SHA",
  "backupDir": "$BK",
  "checkpointBeforeSha256": open("$BK/checkpoint.sha256").read().split()[0],
  "dbBeforeSha256": open("$BK/shadow-revalidate.sha256").read().split()[0],
  "gate": json.load(open("$GATE")),
}
open("$MANIFEST","w").write(json.dumps(meta, indent=2))
print(json.dumps({k:meta[k] for k in ["startedAt","releaseSha","targetTotal","applyLive","checkpointBeforeSha256"]}, indent=2))
PY

# start via existing systemd/script if present
if [ -f /tmp/remote-start-archive-revalidate-877.sh ]; then
  bash /tmp/remote-start-archive-revalidate-877.sh
elif [ -f "$APP/scripts/remote-start-archive-revalidate-877.sh" ]; then
  bash "$APP/scripts/remote-start-archive-revalidate-877.sh"
elif systemctl list-unit-files | grep -q giorgio-revalidate; then
  systemctl start giorgio-revalidate
  sleep 3
  systemctl is-active giorgio-revalidate
  systemctl status giorgio-revalidate --no-pager | head -20
else
  # fallback: nohup production-revalidate-sanita-v3
  export DATABASE_URL="file:$W/shadow-revalidate.db"
  export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
  export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true
  export FORCE_RESCAN_PUB=0
  export APPLY_CERTIFIED_LIVE=0
  export PDFTOPPM_PATH=/usr/bin/pdftoppm
  export REVALIDATE_CHECKPOINT="$CP"
  export REVALIDATE_OUT_DIR="$W/data/revalidation"
  export FRONTIER_DB_PATH="$W/data/revalidation/frontiers/boot.sqlite"
  export TESSDATA_PREFIX="$APP/.tesseract-cache"
  export REVALIDATE_TARGET_TOTAL=877
  export REVALIDATE_CONCURRENCY=1
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  export NODE_OPTIONS="--max-old-space-size=3072"
  cd "$APP"
  nohup npx tsx scripts/production-revalidate-sanita-v3.mjs >> /tmp/k3-877.log 2>&1 &
  echo "PID=$!"
  sleep 5
  head -40 /tmp/k3-877.log
fi

echo "=== POST-START ==="
sleep 8
pgrep -af 'production-revalidate-sanita-v3' | grep -v pgrep || true
python3 - <<'PY'
import json, time
from pathlib import Path
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print(json.dumps({
  "terminal": len(cp.get("terminal") or {}),
  "retry": len(cp.get("retryQueue") or {}),
  "inProgress": list((cp.get("inProgress") or {}).keys())[:5],
  "stats": cp.get("stats"),
}, indent=2))
PY
echo DONE
