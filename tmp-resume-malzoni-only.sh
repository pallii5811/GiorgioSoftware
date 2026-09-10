#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
OUT=/opt/leadsniper-revalidate/data/stopship-retry11-rerun
SHA=$(cat "$APP/RELEASE_SHA")
systemctl stop giorgio-revalidate || true
pkill -TERM -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -TERM -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
sleep 3
pkill -KILL -f "production-revalidate-sanita-v3.mjs" 2>/dev/null || true
pkill -KILL -f "production-revalidate-sanita-worker.mjs" 2>/dev/null || true
# kill hung chromium from PW
pkill -KILL -f "chromium" 2>/dev/null || true
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
export SKIP_PLAYWRIGHT=1
export REVALIDATE_FINALIZE_RESUME=1
export PLAYWRIGHT_TIMEOUT_MS=30000
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
sleep 5
echo RELEASE=$(cat $APP/RELEASE_SHA)
echo giorgio=$(systemctl is-active giorgio-revalidate || true)
tail -n 12 $OUT/targeted.log
python3 /tmp/tmp-peek-two-results.py || true
