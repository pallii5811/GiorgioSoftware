#!/usr/bin/env bash
# Re-run Pini + Marcianise with SI-aware engine (Malzoni already SELF).
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG=/tmp/k3-pini-marc.log
IDS="cmqklex5q00bh108eq9blm01k,cmqoe7vww004aaa3v67rkgl4e"

if pgrep -af 'k3-micro-canary10|production-revalidate-sanita-v3' | grep -v pgrep >/dev/null; then
  echo "ABORT engine running"; exit 3
fi

echo "SHA=$(cat $APP/RELEASE_SHA)" | tee "$LOG"

python3 - <<'PY'
import json, time, sqlite3
from pathlib import Path
W = Path("/opt/leadsniper-revalidate")
# ensure Marcianise website
con = sqlite3.connect(str(W / "shadow-revalidate.db"))
OFF = "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/"
con.execute("update Lead set website=? where id=?", (OFF, "cmqoe7vww004aaa3v67rkgl4e"))
con.commit()
print("marc_web", con.execute("select website from Lead where id=?", ("cmqoe7vww004aaa3v67rkgl4e",)).fetchone())
con.close()

cp_path = W / "data/revalidation/checkpoint.json"
cp = json.loads(cp_path.read_text())
now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
ids = ["cmqklex5q00bh108eq9blm01k", "cmqoe7vww004aaa3v67rkgl4e"]
cp["inProgress"] = {}
for i in ids:
  prev = cp.get("terminal", {}).pop(i, None)
  if prev: print("demoted", i, prev.get("processingState"))
  cp.setdefault("retryQueue", {})[i] = {
    "attempts": int((cp.get("retryQueue", {}).get(i) or {}).get("attempts") or 0),
    "nextRetryAt": now,
    "lastError": "FINAL_PINI_MARC",
    "lastReason": "CRAWL_CAP",
    "firstSeenAt": now,
  }
  cp["retryQueue"][i].pop("frontierPath", None)
  cp["retryQueue"][i].pop("lastRunId", None)
cp_path.write_text(json.dumps(cp, indent=2))
print("due", ids)
PY

export DATABASE_URL="file:$W/shadow-revalidate.db"
export SCAN_ENGINE_LOCAL=1 OCR_ENABLED=1 POLICY_EXHAUSTIVE=1 SCAN_FAST=0
export STAGING_MODE=true DISABLE_LIVE_DB=true DISABLE_EMAILS=true FORCE_RESCAN_PUB=1
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export REVALIDATE_CHECKPOINT="$W/data/revalidation/checkpoint.json"
export REVALIDATE_OUT_DIR="$W/data/revalidation"
export FRONTIER_DB_PATH="$W/data/revalidation/frontiers/boot.sqlite"
export TESSDATA_PREFIX="$APP/.tesseract-cache"
export CRAWL_HTML_URL_CAP=200
export CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
export REVALIDATE_LEAD_WALL_MS=2700000
export CRAWL_NODE_STALL_MS=180000
export K3_IDS="$IDS"
export K3_OUT="$W/data/k3-stopship/FINAL_THREE_RESULTS.json"
export K3_WORKDIR="$W" K3_APP="$APP" K3_GLOBAL_TIMEOUT_MS=10800000
export K3_DISABLE_AUDIT_STOP=1
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
echo "start $(date -u -Iseconds)" | tee -a "$LOG"
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 4
head -30 "$LOG"
