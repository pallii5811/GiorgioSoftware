#!/usr/bin/env bash
# Hotfix archive metrics on blue UI only — never touch giorgio-revalidate.
set -euo pipefail
APP=/opt/leadsniper
STAGING=/tmp/metrics-fix-ui
echo "REVAL_BEFORE=$(systemctl is-active giorgio-revalidate || true)"
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
install -m 0644 "$STAGING/src/app/api/sanita/archive-revalidation/route.ts" \
  "$APP/src/app/api/sanita/archive-revalidation/route.ts"
install -m 0644 "$STAGING/src/components/sanita-leads.tsx" \
  "$APP/src/components/sanita-leads.tsx"
cd "$APP"
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export NODE_ENV=production
npm run build
pm2 restart leadsniper-ui --update-env
sleep 6
echo "REVAL_AFTER=$(systemctl is-active giorgio-revalidate || true)"
curl -sS --max-time 20 http://127.0.0.1:3000/api/sanita/archive-revalidation
echo
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
