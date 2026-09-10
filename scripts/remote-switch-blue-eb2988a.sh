#!/usr/bin/env bash
set -uo pipefail
# Switch blue UI to green code (eb2988a), preserve live DB/env.
APP_BLUE=/opt/leadsniper
APP_GREEN=/opt/leadsniper-green
test -f "$APP_GREEN/RELEASE_SHA"
# Backup blue code tarball for rollback
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /opt/leadsniper/backups
tar -czf "/opt/leadsniper/backups/code-release-pre-switch-$TS.tgz" \
  --exclude=node_modules --exclude=.next --exclude='*.db' --exclude='*.db-*' \
  --exclude=backups --exclude=shadow --exclude=data \
  -C "$APP_BLUE" . 2>/dev/null || true
rsync -a --delete \
  --exclude=.env --exclude=.env.* --exclude='*.db' --exclude='*.db-*' \
  --exclude=backups --exclude=shadow --exclude=data/revalidation \
  --exclude=node_modules --exclude=.next \
  "$APP_GREEN/" "$APP_BLUE/"
# Bring node_modules + build if present
rsync -a "$APP_GREEN/node_modules/" "$APP_BLUE/node_modules/"
if [ -d "$APP_GREEN/.next" ]; then
  rsync -a --delete "$APP_GREEN/.next/" "$APP_BLUE/.next/"
else
  cd "$APP_BLUE" && npm run build
fi
cp -a "$APP_GREEN/RELEASE_SHA" "$APP_BLUE/RELEASE_SHA"
cd "$APP_BLUE"
# Ensure production env flags without printing secrets
grep -q ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE .env 2>/dev/null || \
  echo 'ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1' >> .env
# Force key flags via pm2 env
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production
pm2 restart leadsniper-ui --update-env
sleep 6
curl -sf --max-time 20 'http://127.0.0.1:3000/api/sanita?region=Campania' -o /tmp/health-sanita.json
python3 - <<'PY'
import json
j=json.load(open("/tmp/health-sanita.json"))
print(json.dumps({
  "success": j.get("success"),
  "count": j.get("count") or j.get("actionableCount") or len(j.get("data") or []),
  "filteredDefault": j.get("filteredDefault"),
  "sha": open("/opt/leadsniper/RELEASE_SHA").read().strip(),
}, indent=2))
PY
echo SWITCH_OK
