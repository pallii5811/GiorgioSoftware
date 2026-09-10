#!/usr/bin/env bash
# Deploy K3 client UI (buttons + control/results APIs). Never touch revalidate worker/checkpoint.
set -euo pipefail
APP=/opt/leadsniper
STAGING=/tmp/k3-ui-deploy
TS=$(date -u +%Y%m%dT%H%M%SZ)
SHA=$(cat "$STAGING/RELEASE_SHA" 2>/dev/null || echo "k3-ui-$TS")

echo "=== PRE ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA=$(cat $APP/RELEASE_SHA 2>/dev/null || true)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/k3-cp-before-ui.sha
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs | tee /tmp/k3-worker-before-ui.sha
# Do NOT kill micro-canary
pgrep -af 'k3-micro-canary10' || echo "no micro-canary proc (ok if finished)"

test -f "$STAGING/src/components/sanita-leads.tsx"
test -f "$STAGING/src/app/api/sanita/archive-revalidation/control/route.ts"
test -f "$STAGING/src/app/api/sanita/archive-revalidation/results/route.ts"
test -f "$STAGING/src/app/api/sanita/archive-revalidation/route.ts"

BK=/opt/leadsniper/backups/k3-ui-$TS
mkdir -p "$BK/api" "$BK/components" "$BK/lib"
cp -a "$APP/src/components/sanita-leads.tsx" "$BK/components/" 2>/dev/null || true
cp -a "$APP/src/app/api/sanita" "$BK/api/" 2>/dev/null || true
cp -a "$APP/src/lib/sanita" "$BK/lib/" 2>/dev/null || true

mkdir -p \
  "$APP/src/components" \
  "$APP/src/app/api/sanita/archive-revalidation/control" \
  "$APP/src/app/api/sanita/archive-revalidation/results" \
  "$APP/src/lib/sanita"

install -m 0644 "$STAGING/src/components/sanita-leads.tsx" "$APP/src/components/sanita-leads.tsx"
install -m 0644 "$STAGING/src/app/api/sanita/archive-revalidation/route.ts" "$APP/src/app/api/sanita/archive-revalidation/route.ts"
install -m 0644 "$STAGING/src/app/api/sanita/archive-revalidation/control/route.ts" "$APP/src/app/api/sanita/archive-revalidation/control/route.ts"
install -m 0644 "$STAGING/src/app/api/sanita/archive-revalidation/results/route.ts" "$APP/src/app/api/sanita/archive-revalidation/results/route.ts"

# deps used by control route
if [ -f "$STAGING/src/lib/sanita/job-watchdog.ts" ]; then
  install -m 0644 "$STAGING/src/lib/sanita/job-watchdog.ts" "$APP/src/lib/sanita/job-watchdog.ts"
fi
if [ -f "$STAGING/src/lib/sanita/scan-engine-url.ts" ]; then
  install -m 0644 "$STAGING/src/lib/sanita/scan-engine-url.ts" "$APP/src/lib/sanita/scan-engine-url.ts"
fi
# optional copy helpers if present in staging
for f in client-facing-copy.ts audit-queue-badge.ts published-subtype.ts verdict.ts present-sanita-lead.ts; do
  if [ -f "$STAGING/src/lib/sanita/$f" ]; then
    install -m 0644 "$STAGING/src/lib/sanita/$f" "$APP/src/lib/sanita/$f"
  fi
done
if [ -f "$STAGING/src/app/api/sanita/route.ts" ]; then
  install -m 0644 "$STAGING/src/app/api/sanita/route.ts" "$APP/src/app/api/sanita/route.ts"
fi

printf '%s\n' "$SHA" > "$APP/RELEASE_SHA"
printf 'k3-ui-%s\n' "$TS" > "$APP/UI_PRESENTATION_STAMP"

cd "$APP"
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production
npm run build
pm2 restart leadsniper-ui --update-env
sleep 12

echo "=== POST ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA=$(cat $APP/RELEASE_SHA)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/k3-cp-after-ui.sha
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs | tee /tmp/k3-worker-after-ui.sha
diff -u /tmp/k3-cp-before-ui.sha /tmp/k3-cp-after-ui.sha
diff -u /tmp/k3-worker-before-ui.sha /tmp/k3-worker-after-ui.sha

curl -sS --max-time 20 'http://127.0.0.1:3000/sanita' -o /dev/null -w 'sanita=%{http_code}\n'
curl -sS --max-time 20 'http://127.0.0.1:3000/api/sanita/archive-revalidation' | head -c 500; echo
curl -sS --max-time 20 'http://127.0.0.1:3000/api/sanita/archive-revalidation/control' | head -c 500; echo
grep -c 'Avvia scansione' "$APP/src/components/sanita-leads.tsx"
pgrep -af 'k3-micro-canary10' || echo "micro-canary not running"
echo K3_UI_DEPLOY_OK
