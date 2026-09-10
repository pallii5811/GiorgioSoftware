#!/bin/bash
set -euo pipefail
UI=/opt/leadsniper
APP=/opt/leadsniper-revalidate/app
systemctl stop giorgio-revalidate 2>/dev/null || true

install -m 644 /tmp/patch/policy-scheda-extract.ts "$UI/src/lib/sanita/policy-scheda-extract.ts"
install -m 644 /tmp/patch/policy-scheda-extract.ts "$APP/src/lib/sanita/policy-scheda-extract.ts"
mkdir -p "$UI/src/lib/sanita/fixtures" "$APP/src/lib/sanita/fixtures"
install -m 644 /tmp/patch/scheda-polizza-anon.ts "$UI/src/lib/sanita/fixtures/scheda-polizza-anon.ts"
install -m 644 /tmp/patch/scheda-polizza-anon.ts "$APP/src/lib/sanita/fixtures/scheda-polizza-anon.ts"
install -m 644 /tmp/patch/detector.ts "$UI/src/lib/sanita/detector.ts"
install -m 644 /tmp/patch/detector.ts "$APP/src/lib/sanita/detector.ts"
install -m 644 /tmp/patch/archive-results-map.ts "$UI/src/lib/sanita/archive-results-map.ts"
install -m 644 /tmp/patch/archive-results-map.ts "$APP/src/lib/sanita/archive-results-map.ts"
install -m 644 /tmp/patch/sanita-leads.tsx "$UI/src/components/sanita-leads.tsx"
install -m 644 /tmp/patch/sanita-leads.tsx "$APP/src/components/sanita-leads.tsx"
mkdir -p "$UI/src/app/api/sanita/archive-revalidation/evidence-file"
mkdir -p "$APP/src/app/api/sanita/archive-revalidation/evidence-file"
install -m 644 /tmp/patch/evidence-file-route.ts "$UI/src/app/api/sanita/archive-revalidation/evidence-file/route.ts"
install -m 644 /tmp/patch/evidence-file-route.ts "$APP/src/app/api/sanita/archive-revalidation/evidence-file/route.ts"
install -m 644 /tmp/patch/test-scheda-polizza-extract.mjs "$UI/scripts/test-scheda-polizza-extract.mjs"
install -m 644 /tmp/patch/test-scheda-polizza-extract.mjs "$APP/scripts/test-scheda-polizza-extract.mjs"

cd "$UI"
export SCAN_ENGINE_LOCAL=1
export DATABASE_URL="file:$UI/prisma/dev.db"
npm run build 2>&1 | tail -25
pm2 restart leadsniper-ui --update-env
sleep 3
curl -s -o /dev/null -w "ui=%{http_code}\n" http://127.0.0.1:3000/sanita
echo DEPLOY_OK
