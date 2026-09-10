#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
staging="/tmp/codex-national-discovery"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/opt/leadsniper/backups/national-discovery-$stamp"
checkpoint="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
worker="/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs"
files=(
  "data/comuni.json"
  "scripts/sanita-national-discovery-runner.mjs"
  "scripts/test-national-territory.mjs"
  "src/components/sanita-leads.tsx"
  "src/app/api/sanita/national-discovery/route.ts"
  "src/lib/sanita/italy-regions.ts"
  "src/lib/sanita/national-discovery-jobs.ts"
  "src/lib/sanita/discovery.ts"
  "src/lib/sanita/salute.ts"
  "src/lib/sanita/region-cities.ts"
  "src/lib/sanita/region-min-leads.ts"
  "src/lib/sanita/maps-discovery.ts"
  "src/lib/sanita/discover-region.ts"
  "src/lib/sanita/playwright-launch.ts"
  "src/lib/sanita/playwright-maps.ts"
)

for file in "${files[@]}"; do
  test -f "$staging/$file"
done

mkdir -p "$backup/app"
sha256sum "$checkpoint" >"$backup/checkpoint.before.sha"
sha256sum "$worker" >"$backup/worker.before.sha"
systemctl is-active --quiet giorgio-revalidate

for file in "${files[@]}"; do
  if [[ -f "$app/$file" ]]; then
    mkdir -p "$backup/app/$(dirname "$file")"
    cp "$app/$file" "$backup/app/$file"
  fi
  install -D -m 0644 "$staging/$file" "$app/$file"
done

cd "$app"
export DATABASE_URL="file:/opt/leadsniper/prisma/dev.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production
npx tsx scripts/test-national-territory.mjs
npm run build
pm2 restart leadsniper-ui --update-env
sleep 8

systemctl is-active --quiet giorgio-revalidate
sha256sum "$checkpoint" >"$backup/checkpoint.after.sha"
sha256sum "$worker" >"$backup/worker.after.sha"
diff -u "$backup/worker.before.sha" "$backup/worker.after.sha"
python3 - "$checkpoint" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    checkpoint = json.load(handle)
assert isinstance(checkpoint.get("terminal"), dict)
assert isinstance(checkpoint.get("retryQueue"), dict)
assert isinstance(checkpoint.get("inProgress"), dict)
print("CHECKPOINT_VALID", len(checkpoint["terminal"]), len(checkpoint["retryQueue"]))
PY

curl -fsS --max-time 30 \
  "http://127.0.0.1:3000/api/sanita/national-discovery?region=Campania" \
  | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j["success"]; assert len(j["regions"]) == 20; assert j["municipalityCount"] == 550; print("API_OK", len(j["regions"]), j["municipalityCount"])'
curl -fsS --max-time 30 "http://127.0.0.1:3000/sanita" >/dev/null

echo "REVALIDATION=$(systemctl is-active giorgio-revalidate)"
echo "BACKUP=$backup"
echo "NATIONAL_DISCOVERY_DEPLOY_OK"
