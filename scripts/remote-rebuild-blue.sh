#!/usr/bin/env bash
set -uo pipefail
cd /opt/leadsniper
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production
# Ensure env file has the flag
grep -q '^ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=' .env 2>/dev/null || echo 'ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1' >> .env
npm run build
pm2 restart leadsniper-ui --update-env
sleep 8
curl -sS --max-time 20 "http://127.0.0.1:3000/api/sanita?region=Campania" | python3 -m json.tool | head -40
echo BUILD=$(cat .next/BUILD_ID)
echo SHA=$(cat RELEASE_SHA)
