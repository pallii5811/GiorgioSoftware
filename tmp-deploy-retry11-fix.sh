#!/bin/bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
SRC=/tmp/stopship-sync2
test -d "$SRC"

cp -a "$SRC/playwright-launch.ts" "$APP/src/lib/sanita/playwright-launch.ts"
cp -a "$SRC/crawl-relevance.ts" "$APP/src/lib/sanita/crawl-relevance.ts"
cp -a "$SRC/playwright-maps.ts" "$APP/src/lib/sanita/playwright-maps.ts"
cp -a "$SRC/crawl-slice-runner.ts" "$APP/src/lib/sanita/crawl-slice-runner.ts"
cp -a "$SRC/frontier-store.ts" "$APP/src/lib/sanita/frontier-store.ts"
cp -a "$SRC/crawl-budget.ts" "$APP/src/lib/sanita/crawl-budget.ts"
cp -a "$SRC/sitemap-pipeline.ts" "$APP/src/lib/sanita/sitemap-pipeline.ts"
cp -a "$SRC/production-revalidate-sanita-v3.mjs" "$APP/scripts/production-revalidate-sanita-v3.mjs"
cp -a "$SRC/production-revalidate-sanita-worker.mjs" "$APP/scripts/production-revalidate-sanita-worker.mjs"
cp -a "$SRC/revalidate-checkpoint-v3.mjs" "$APP/scripts/revalidate-checkpoint-v3.mjs"

echo 40574b7263c0834da51404d25cfc1f375ab0db36 > "$APP/RELEASE_SHA"
# keep unit budgets
systemctl stop giorgio-revalidate || true
systemctl is-active giorgio-revalidate || true

# verify chromium snap usable
ls -la /snap/bin/chromium
# also install playwright chromium as fallback (non-fatal)
cd "$APP"
npx --yes playwright install chromium 2>&1 | tail -n 20 || true

node scripts/test-stopship-no-tech-terminal.mjs
npx --yes tsx scripts/test-stopship-retry-storm.mjs
echo DEPLOY_OK sha=$(cat RELEASE_SHA)
