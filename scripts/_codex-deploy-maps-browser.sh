#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
staging="/tmp/codex-maps-browser"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper/backups/maps-browser-$stamp"
reval_before="$(systemctl is-active giorgio-revalidate || true)"
worker="/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs"

test -f "$staging/playwright-launch.ts"
test -f "$staging/playwright-maps.ts"
mkdir -p "$backup"
sha256sum "$worker" >"$backup/worker.before.sha"
cp -a "$app/src/lib/sanita/playwright-maps.ts" "$backup/playwright-maps.ts"
if [[ -f "$app/src/lib/sanita/playwright-launch.ts" ]]; then
  cp -a "$app/src/lib/sanita/playwright-launch.ts" "$backup/playwright-launch.ts"
fi

install -D -m 0644 "$staging/playwright-launch.ts" "$app/src/lib/sanita/playwright-launch.ts"
install -D -m 0644 "$staging/playwright-maps.ts" "$app/src/lib/sanita/playwright-maps.ts"

cd "$app"
export DATABASE_URL="file:/opt/leadsniper/prisma/dev.db"
export SCAN_ENGINE_LOCAL=1
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/usr/bin/chromium-browser"
export NODE_ENV=production
npm run build
pm2 restart leadsniper-ui --update-env
sleep 6

sha256sum "$worker" >"$backup/worker.after.sha"
diff -u "$backup/worker.before.sha" "$backup/worker.after.sha"
reval_after="$(systemctl is-active giorgio-revalidate || true)"
test "$reval_before" = "$reval_after"
echo "REVALIDATION=$reval_after"
echo "BACKUP=$backup"
echo "MAPS_BROWSER_DEPLOY_OK"
