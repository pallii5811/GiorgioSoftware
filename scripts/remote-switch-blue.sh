#!/usr/bin/env bash
# Switch green → blue (code only; keep live DB)
set -euo pipefail
APP_BLUE=/opt/leadsniper
APP_GREEN=/opt/leadsniper-green
test -f "$APP_GREEN/RELEASE_SHA"
# backup current blue code tree lightly
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /opt/leadsniper/backups
tar -czf "/opt/leadsniper/backups/blue-pre-switch-$TS.tgz" \
  -C "$APP_BLUE" --exclude=node_modules --exclude=.next --exclude='prisma/*.db*' --exclude=backups --exclude=shadow \
  . 2>/dev/null || true
rsync -a --delete \
  --exclude=.env --exclude=.env.* --exclude='*.db' --exclude='*.db-*' \
  --exclude=backups --exclude=shadow --exclude=data/revalidation --exclude=prisma/dev.db \
  "$APP_GREEN/" "$APP_BLUE/"
# ensure env flags
cd "$APP_BLUE"
grep -q '^ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=' .env 2>/dev/null || echo 'ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1' >> .env
grep -q '^SCAN_ENGINE_LOCAL=' .env 2>/dev/null || echo 'SCAN_ENGINE_LOCAL=1' >> .env
grep -q '^OCR_ENABLED=' .env 2>/dev/null || echo 'OCR_ENABLED=1' >> .env
grep -q '^POLICY_EXHAUSTIVE=' .env 2>/dev/null || echo 'POLICY_EXHAUSTIVE=1' >> .env
grep -q '^SCAN_FAST=' .env && sed -i 's/^SCAN_FAST=.*/SCAN_FAST=0/' .env || echo 'SCAN_FAST=0' >> .env
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production
pm2 restart leadsniper-ui --update-env
sleep 8
curl -sf --max-time 40 'http://127.0.0.1:3000/api/sanita?region=Campania' > /tmp/blue-health.json
python3 - <<'PY'
import json
j=json.load(open("/tmp/blue-health.json"))
assert "data" in j or j.get("success") is True
print("BLUE_HEALTH_OK", "sha", open("/opt/leadsniper/RELEASE_SHA").read().strip())
print("returned", len(j.get("data") or []))
PY
echo SWITCH_OK
