#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
staging="/tmp/codex-frontier-env-fix"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper/backups/frontier-env-fix-$stamp"
worker="/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs"
checkpoint="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
archive_before="$(systemctl is-active giorgio-revalidate || true)"

mkdir -p "$backup/scripts" "$backup/src/lib/sanita"
sha256sum "$worker" >"$backup/worker.before.sha"
sha256sum "$checkpoint" >"$backup/checkpoint.before.sha"
cp "$app/scripts/sanita-national-discovery-runner.mjs" "$backup/scripts/"
cp "$app/scripts/test-national-territory.mjs" "$backup/scripts/"
cp "$app/src/lib/sanita/national-discovery-jobs.ts" "$backup/src/lib/sanita/"
cp "$app/src/lib/sanita/lead-crawl-runtime.ts" "$backup/src/lib/sanita/"
cp "$app/src/lib/sanita/scan-engine.ts" "$backup/src/lib/sanita/"

install -m 0644 \
  "$staging/scripts/sanita-national-discovery-runner.mjs" \
  "$app/scripts/sanita-national-discovery-runner.mjs"
install -m 0644 \
  "$staging/scripts/test-national-territory.mjs" \
  "$app/scripts/test-national-territory.mjs"
install -m 0644 \
  "$staging/scripts/_codex-repair-crotone-frontier.mjs" \
  "$app/scripts/_codex-repair-crotone-frontier.mjs"
install -m 0644 \
  "$staging/scripts/_codex-close-alt-inconclusive-review.mjs" \
  "$app/scripts/_codex-close-alt-inconclusive-review.mjs"
install -m 0644 \
  "$staging/src/lib/sanita/national-discovery-jobs.ts" \
  "$app/src/lib/sanita/national-discovery-jobs.ts"
install -m 0644 \
  "$staging/src/lib/sanita/lead-crawl-runtime.ts" \
  "$app/src/lib/sanita/lead-crawl-runtime.ts"
install -m 0644 \
  "$staging/src/lib/sanita/scan-engine.ts" \
  "$app/src/lib/sanita/scan-engine.ts"

cd "$app"
export DATABASE_URL="file:/opt/leadsniper/prisma/dev.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production

node --check scripts/sanita-national-discovery-runner.mjs
npx tsx scripts/test-national-territory.mjs
npx tsx scripts/_codex-repair-crotone-frontier.mjs \
  f2d3fe0e-0b36-4535-a99d-33f4c9f14371
npx tsx scripts/_codex-close-alt-inconclusive-review.mjs
npm run build
pm2 restart leadsniper-ui --update-env
sleep 8

archive_after="$(systemctl is-active giorgio-revalidate || true)"
test "$archive_before" = "$archive_after"
sha256sum "$worker" >"$backup/worker.after.sha"
sha256sum "$checkpoint" >"$backup/checkpoint.after.sha"
diff -u "$backup/worker.before.sha" "$backup/worker.after.sha"
diff -u "$backup/checkpoint.before.sha" "$backup/checkpoint.after.sha"

curl -fsS --max-time 30 \
  "http://127.0.0.1:3000/api/sanita/national-discovery?region=Calabria" \
  | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j["success"]; assert len(j["regions"]) == 20; assert "Crotone" in j["municipalities"]; print("API_OK", len(j["regions"]), j["municipalityCount"])'

printf 'ARCHIVE_STATE=%s\nBACKUP=%s\nDEPLOY_OK\n' "$archive_after" "$backup"
