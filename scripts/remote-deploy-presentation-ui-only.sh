#!/usr/bin/env bash
# Deploy ONLY presentation UI/API files to blue. Do NOT touch giorgio-revalidate / checkpoint / DB.
set -euo pipefail
SHA="${1:?SHA required}"
APP=/opt/leadsniper
STAGING=/tmp/presentation-ui-deploy

echo "=== PRE ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA_BEFORE=$(cat $APP/RELEASE_SHA 2>/dev/null || true)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-before.sha
stat -c '%y %s %n' /opt/leadsniper-revalidate/data/revalidation/checkpoint.json || true
ls -la "$STAGING"
test -f "$STAGING/src/app/api/sanita/route.ts"
test -f "$STAGING/src/components/sanita-leads.tsx"
test -f "$STAGING/src/lib/sanita/audit-queue-badge.ts"

# Backup presentation files only
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/leadsniper/backups/presentation-pre-$TS
mkdir -p "$BK/src/app/api/sanita" "$BK/src/components" "$BK/src/lib/sanita"
cp -a "$APP/src/app/api/sanita/route.ts" "$BK/src/app/api/sanita/" || true
cp -a "$APP/src/components/sanita-leads.tsx" "$BK/src/components/" || true
cp -a "$APP/src/lib/sanita/audit-queue-badge.ts" "$BK/src/lib/sanita/" 2>/dev/null || true
echo "$BK"

# Install files (no rsync of whole tree)
install -m 0644 "$STAGING/src/app/api/sanita/route.ts" "$APP/src/app/api/sanita/route.ts"
install -m 0644 "$STAGING/src/components/sanita-leads.tsx" "$APP/src/components/sanita-leads.tsx"
mkdir -p "$APP/src/lib/sanita"
install -m 0644 "$STAGING/src/lib/sanita/audit-queue-badge.ts" "$APP/src/lib/sanita/audit-queue-badge.ts"
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

echo "=== POST ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA_AFTER=$(cat $APP/RELEASE_SHA)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-after.sha
diff -u /tmp/cp-before.sha /tmp/cp-after.sha
curl -sS --max-time 30 'http://127.0.0.1:3000/api/sanita?includePending=1&includeAll=1' -o /tmp/sanita-all.json
python3 - <<'PY'
import json
j=json.load(open("/tmp/sanita-all.json"))
m=j.get("meta") or {}
print(json.dumps({
  "success": j.get("success"),
  "returned": len(j.get("data") or []),
  "actionableCount": m.get("actionableCount"),
  "dbTotal": m.get("dbTotal"),
  "regions": {k: {"total": v.get("total"), "done": v.get("done"), "pending": v.get("pending")} for k,v in (m.get("regions") or {}).items()},
  "kpis": {k: (m.get("kpis") or {}).get(k) for k in ["total","actionable","inRevalidation"]},
  "revalidationUiLock": m.get("revalidationUiLock"),
  "includeAll": m.get("includeAll"),
  "filteredDefault": m.get("filteredDefault"),
}, indent=2))
PY
echo DEPLOY_PRESENTATION_OK
