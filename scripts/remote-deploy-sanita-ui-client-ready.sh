#!/usr/bin/env bash
# Deploy presentation UI only — NEVER touch giorgio-revalidate / checkpoint / DB / worker tree.
set -euo pipefail
APP=/opt/leadsniper
STAGING=/tmp/sanita-ui-client-ready
TS=$(date -u +%Y%m%dT%H%M%SZ)

echo "=== PRE ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA=$(cat $APP/RELEASE_SHA 2>/dev/null || true)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-before-ui.sha
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs | tee /tmp/worker-before-ui.sha

test -d "$STAGING"

BK=/opt/leadsniper/backups/presentation-ui-$TS
mkdir -p "$BK"
cp -a "$APP/src/components/sanita-leads.tsx" "$BK/" 2>/dev/null || true
cp -a "$APP/src/app/api/sanita" "$BK/api-sanita" 2>/dev/null || true
cp -a "$APP/src/lib/sanita/audit-queue-badge.ts" "$BK/" 2>/dev/null || true
cp -a "$APP/src/lib/sanita/published-subtype.ts" "$BK/" 2>/dev/null || true
cp -a "$APP/src/lib/sanita/verdict.ts" "$BK/" 2>/dev/null || true
echo "backup=$BK"

mkdir -p "$APP/src/app/api/sanita/archive-revalidation" "$APP/src/lib/sanita" "$APP/src/components"
install -m 0644 "$STAGING/src/components/sanita-leads.tsx" "$APP/src/components/sanita-leads.tsx"
install -m 0644 "$STAGING/src/app/api/sanita/route.ts" "$APP/src/app/api/sanita/route.ts"
install -m 0644 "$STAGING/src/app/api/sanita/archive-revalidation/route.ts" "$APP/src/app/api/sanita/archive-revalidation/route.ts"
install -m 0644 "$STAGING/src/lib/sanita/audit-queue-badge.ts" "$APP/src/lib/sanita/audit-queue-badge.ts"
install -m 0644 "$STAGING/src/lib/sanita/client-facing-copy.ts" "$APP/src/lib/sanita/client-facing-copy.ts"
install -m 0644 "$STAGING/src/lib/sanita/published-subtype.ts" "$APP/src/lib/sanita/published-subtype.ts"
install -m 0644 "$STAGING/src/lib/sanita/verdict.ts" "$APP/src/lib/sanita/verdict.ts"
# Keep existing RELEASE_SHA (do not rewrite certified app SHA)
printf 'ui-client-ready-%s\n' "$TS" > "$APP/UI_PRESENTATION_STAMP"

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
sleep 10

echo "=== POST ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-after-ui.sha
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs | tee /tmp/worker-after-ui.sha
diff -u /tmp/cp-before-ui.sha /tmp/cp-after-ui.sha
diff -u /tmp/worker-before-ui.sha /tmp/worker-after-ui.sha

curl -sS --max-time 30 'http://127.0.0.1:3000/api/sanita/archive-revalidation' | head -c 800; echo
curl -sS --max-time 60 'http://127.0.0.1:3000/api/sanita?includePending=1&includeAll=1' -o /tmp/sanita-ui.json
python3 - <<'PY'
import json
j=json.load(open("/tmp/sanita-ui.json"))
k=(j.get("meta") or {}).get("kpis") or {}
c=k.get("commercial") or {}
s=c.get("policyValid",0)+c.get("policyExpired",0)+c.get("dateUnknown",0)+c.get("absenceCertified",0)
print(json.dumps({
  "dbTotal": (j.get("meta") or {}).get("dbTotal"),
  "actionable": k.get("actionable"),
  "notYetCertified": k.get("notYetCertified"),
  "commercial": c,
  "commercialSum": s,
  "hasInRevalidationLabel": "inRevalidation" in k,
}, indent=2))
PY
echo "=== UI DEPLOY DONE ==="
