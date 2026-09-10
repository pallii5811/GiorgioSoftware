#!/usr/bin/env bash
# UI-only structural redesign deploy. Never touches giorgio-revalidate / checkpoint / worker.
set -euo pipefail
SHA="${1:?SHA required}"
APP=/opt/leadsniper
STAGING=/tmp/sanita-structural-ui

echo "=== PRE worker/checkpoint ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
WORKER=/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs
EXPECTED_WORKER_SHA=f8843a46bfb1b3734116306216ee3d3bf52171fb2a45fb27f3331c9175acf071
sha256sum "$WORKER" | tee /tmp/worker-before.sha
grep -q "$EXPECTED_WORKER_SHA" /tmp/worker-before.sha || {
  echo "WORKER HASH MISMATCH — abort (expected fe8b677 canonical)";
  cat /tmp/worker-before.sha;
  exit 2;
}
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-before.sha
test -f "$STAGING/src/components/sanita-leads.tsx"
test -f "$STAGING/src/app/api/sanita/archive-revalidation/route.ts"

TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/leadsniper/backups/structural-ui-pre-$TS
mkdir -p "$BK/src/components" "$BK/src/app/api/sanita/archive-revalidation"
cp -a "$APP/src/components/sanita-leads.tsx" "$BK/src/components/" || true
cp -a "$APP/src/app/api/sanita/archive-revalidation/route.ts" "$BK/src/app/api/sanita/archive-revalidation/" 2>/dev/null || true
echo "BACKUP=$BK"

mkdir -p "$APP/src/app/api/sanita/archive-revalidation"
install -m 0644 "$STAGING/src/components/sanita-leads.tsx" "$APP/src/components/sanita-leads.tsx"
install -m 0644 "$STAGING/src/app/api/sanita/archive-revalidation/route.ts" "$APP/src/app/api/sanita/archive-revalidation/route.ts"
printf '%s\n' "$SHA" > "$APP/RELEASE_SHA"

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
sleep 8

echo "=== POST worker/checkpoint ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
sha256sum "$WORKER" | tee /tmp/worker-after.sha
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-after.sha
diff -u /tmp/worker-before.sha /tmp/worker-after.sha
diff -u /tmp/cp-before.sha /tmp/cp-after.sha
curl -sS --max-time 20 'http://127.0.0.1:3000/api/sanita/archive-revalidation' | head -c 500; echo
curl -sS --max-time 20 'http://127.0.0.1:3000/sanita' | grep -o 'Verifica polizze sanitarie' | head -1
echo DEPLOY_STRUCTURAL_UI_OK
