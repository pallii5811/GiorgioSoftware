#!/usr/bin/env bash
# Deploy RC-11 Arsenio fixes + retry Arsenio (+ optional analogous) on same sample.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
W=/opt/leadsniper-revalidate
LOG=/tmp/k3-blocker01-retry.log

if pgrep -af 'k3-micro-canary10|production-revalidate-sanita-v3' | grep -v pgrep >/dev/null; then
  echo "ABORT: engine running"; pgrep -af 'k3-micro|production-revalidate' || true; exit 3
fi

# Sync patched sources from /tmp/rc11-src
SRC=/tmp/rc11-src
for f in \
  src/lib/sanita/scan-engine.ts \
  src/lib/sanita/lead-crawl-runtime.ts \
  src/lib/sanita/crawl-slice-runner.ts \
  src/lib/sanita/frontier-store.ts \
  src/lib/sanita/sitemap-pipeline.ts \
  scripts/production-revalidate-sanita-v3.mjs \
  scripts/test-rc11-arsenio-rootcause.mjs
do
  cp "$SRC/$f" "$APP/$f"
  echo "synced $f"
done

cd "$APP"
npx tsx scripts/test-rc11-arsenio-rootcause.mjs | tee /tmp/rc11-selfcheck.txt

# Demote Arsenio + 2 ANALOGOUS → fresh frontier retry (same sample, no substitution)
python3 - <<'PY'
import json, time
from pathlib import Path
cp_path=Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp=json.loads(cp_path.read_text())
now=time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
ids=[
  "cmqp7cqya00011q5bkqf3ox8q",  # Arsenio
  "cmqktyimz000i111hygme29nh",  # Malzoni ANALOGOUS
  "cmqklex5q00bh108eq9blm01k",  # Pini ANALOGOUS
]
for i in ids:
  if i in cp.get("terminal",{}):
    t=cp["terminal"].pop(i)
    print("demoted_terminal", i, t.get("processingState"))
  prev=cp.get("retryQueue",{}).get(i) or {}
  cp.setdefault("retryQueue",{})[i]={
    "attempts": int(prev.get("attempts") or 0),
    "nextRetryAt": now,
    "lastError": "SITEMAP_UNRESOLVED" if i.startswith("cmqp7") else "ANALOGOUS_REACQUIRE",
    "lastReason": "SITEMAP_UNRESOLVED" if i.startswith("cmqp7") else "CRAWL_CAP",
    "firstSeenAt": now,
  }
  # force fresh frontier (RC-09/RC-11)
  cp["retryQueue"][i].pop("frontierPath", None)
  cp["retryQueue"][i].pop("lastRunId", None)
  if i in cp.get("inProgress",{}):
    cp["inProgress"].pop(i, None)
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
export K3_IDS="cmqp7cqya00011q5bkqf3ox8q,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k"
export K3_OUT="$W/data/k3-stopship/BLOCKER01_RETRY.json"
export K3_WORKDIR="$W" K3_APP="$APP" K3_GLOBAL_TIMEOUT_MS=10800000
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export NODE_OPTIONS="--max-old-space-size=3072"

cd "$APP"
: > "$LOG"
echo "blocker01_start $(date -u -Iseconds)" | tee -a "$LOG"
nohup npx tsx scripts/k3-micro-canary10.mjs >> "$LOG" 2>&1 &
echo "PID=$!"
sleep 4
head -40 "$LOG"
