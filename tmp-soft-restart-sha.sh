#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
OUT=/opt/leadsniper-revalidate/data/stopship-retry11-rerun
SHA=$(cat "$APP/RELEASE_SHA")
systemctl stop giorgio-revalidate || true
python3 /tmp/bump-retries.py || python3 - <<'PY'
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
OUT=Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
cp=json.loads((OUT/"checkpoint.json").read_text())
now=datetime.now(timezone.utc)
for m in (cp.get("retryQueue") or {}).values():
  m["nextRetryAt"]=(now-timedelta(seconds=5)).isoformat()
  m["operational"]=True
  m.pop("parkedEngineCeiling", None)
(OUT/"checkpoint.json").write_text(json.dumps(cp, indent=2))
print("bumped", len(cp.get("retryQueue") or {}))
PY
pkill -TERM -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -TERM -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
for i in $(seq 1 25); do
  pgrep -f "production-revalidate-sanita-v3.mjs" >/dev/null || break
  sleep 1
done
pkill -KILL -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -KILL -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
rm -f "$OUT/targeted.parent.lock" || true
IDS=$(python3 -c "import json; print(','.join(json.load(open('$OUT/ids.json'))['ids']))")
cat > /tmp/run-retry11-rerun.sh <<EOF
#!/bin/bash
set -euo pipefail
APP=$APP
OUT=$OUT
LOG=\$OUT/targeted.log
while IFS= read -r line; do
  case "\$line" in
    *=*) export "\$line" ;;
  esac
done < <(systemctl show giorgio-revalidate -p Environment --value | tr ' ' '\n')
export APPLY_LIVE=0
export DISABLE_LIVE_DB=true
export TOTAL_WORKERS=1
export REVALIDATE_CONCURRENCY=1
export PER_HOST_CONCURRENCY=1
export CRAWL_HTML_URL_CAP=100
export CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
export CRAWL_MAX_HTML_PER_SLICE=24
export REVALIDATE_LEAD_WALL_MS=3300000
export REVALIDATE_SLICE_WALL_MS=3300000
export REVALIDATE_OVERALL_LEAD_WALL_MS=3300000
export OCR_TIMEOUT_MS=180000
export PDF_FETCH_TIMEOUT_MS=60000
export MAX_DOCUMENT_RETRIES=3
export REVALIDATE_MAX_RETRY=5
export REVALIDATE_DUAL_HOT=0
export REVALIDATE_OUT_DIR=\$OUT
export REVALIDATE_CHECKPOINT=\$OUT/checkpoint.json
export REVALIDATE_IDS="$IDS"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
export CHROMIUM_PATH=/snap/bin/chromium
export GIT_HEAD=$SHA
export RELEASE_SHA=$SHA
cd "\$APP"
systemctl stop giorgio-revalidate || true
exec flock -n "\$OUT/targeted.parent.lock" -c "node scripts/production-revalidate-sanita-v3.mjs" >>"\$LOG" 2>&1
EOF
chmod +x /tmp/run-retry11-rerun.sh
nohup /tmp/run-retry11-rerun.sh >/dev/null 2>&1 &
sleep 4
echo RELEASE=$(cat $APP/RELEASE_SHA)
echo giorgio=$(systemctl is-active giorgio-revalidate || true)
tail -n 4 $OUT/targeted.log
tr '\0' '\n' < /proc/$(pgrep -n -f 'node scripts/production-revalidate-sanita-v3')/environ 2>/dev/null | grep -E 'GIT_HEAD|RELEASE_SHA|LEAD_WALL' || true
