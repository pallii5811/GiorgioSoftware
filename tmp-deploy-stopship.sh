#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
# sync expected from /tmp/stopship-sync/
SRC=/tmp/stopship-sync
test -d "$SRC" || { echo "missing $SRC"; exit 1; }
cp -a "$SRC/crawl-relevance.ts" "$APP/src/lib/sanita/crawl-relevance.ts"
cp -a "$SRC/crawl-budget.ts" "$APP/src/lib/sanita/crawl-budget.ts"
cp -a "$SRC/crawl-slice-runner.ts" "$APP/src/lib/sanita/crawl-slice-runner.ts"
cp -a "$SRC/sitemap-pipeline.ts" "$APP/src/lib/sanita/sitemap-pipeline.ts"
cp -a "$SRC/frontier-store.ts" "$APP/src/lib/sanita/frontier-store.ts"
cp -a "$SRC/production-revalidate-sanita-v3.mjs" "$APP/scripts/production-revalidate-sanita-v3.mjs"
cp -a "$SRC/revalidate-checkpoint-v3.mjs" "$APP/scripts/revalidate-checkpoint-v3.mjs"
cp -a "$SRC/test-stopship-no-tech-terminal.mjs" "$APP/scripts/test-stopship-no-tech-terminal.mjs"
cp -a "$SRC/test-stopship-retry-storm.mjs" "$APP/scripts/test-stopship-retry-storm.mjs"
cp -a "$SRC/repair-stopship-retry-storm.py" "$APP/scripts/repair-stopship-retry-storm.py"
# budgets drop-in (concurrency stays 1, APPLY_LIVE=0)
cat > /etc/systemd/system/giorgio-revalidate.service.d/10-stopship-budgets.conf <<'EOF'
[Service]
Environment=APPLY_LIVE=0
Environment=DISABLE_LIVE_DB=true
Environment=TOTAL_WORKERS=1
Environment=REVALIDATE_CONCURRENCY=1
Environment=PER_HOST_CONCURRENCY=1
Environment=CRAWL_HTML_URL_CAP=100
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
Environment=CRAWL_MAX_HTML_PER_SLICE=24
Environment=REVALIDATE_LEAD_WALL_MS=3300000
Environment=REVALIDATE_SLICE_WALL_MS=3300000
Environment=OCR_TIMEOUT_MS=180000
Environment=PDF_FETCH_TIMEOUT_MS=60000
Environment=MAX_DOCUMENT_RETRIES=3
Environment=REVALIDATE_MAX_RETRY=5
EOF
systemctl daemon-reload
# keep service STOPPED
systemctl stop giorgio-revalidate || true
systemctl is-active giorgio-revalidate || true
cd "$APP"
node scripts/test-stopship-no-tech-terminal.mjs
npx --yes tsx scripts/test-stopship-retry-storm.mjs
python3 scripts/repair-stopship-retry-storm.py
echo DEPLOY_OK
