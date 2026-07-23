#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper
install -m 0644 /tmp/k3-rc09/sanita-leads.tsx "$APP/src/components/sanita-leads.tsx"
install -m 0644 /tmp/k3-rc09/route.ts "$APP/src/app/api/sanita/archive-revalidation/results/route.ts"
install -m 0644 /tmp/k3-rc09/archive-results-map.ts "$APP/src/lib/sanita/archive-results-map.ts"
echo 40f2528 > "$APP/RELEASE_SHA"
cd "$APP"
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
echo "build_start $(date -u -Iseconds)" | tee /tmp/k3-ui-build-40f2528.log
if npm run build >> /tmp/k3-ui-build-40f2528.log 2>&1; then
  pm2 restart leadsniper-ui --update-env
  echo BUILD_OK | tee -a /tmp/k3-ui-build-40f2528.log
else
  echo BUILD_FAIL | tee -a /tmp/k3-ui-build-40f2528.log
  exit 1
fi
