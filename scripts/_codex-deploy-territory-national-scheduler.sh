#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
stage="/tmp/codex-territory-national"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$app/backups/territory-national-$stamp"

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
for file in \
  src/lib/sanita/region-cities.ts \
  src/lib/sanita/maps-discovery.ts \
  src/lib/sanita/national-discovery-jobs.ts \
  src/lib/sanita/playwright-maps.ts
do
  test -f "$stage/$file"
done

mkdir -p "$backup/src/lib/sanita"
for file in \
  region-cities.ts \
  maps-discovery.ts \
  national-discovery-jobs.ts \
  playwright-maps.ts
do
  cp "$app/src/lib/sanita/$file" "$backup/src/lib/sanita/$file"
  install -m 0644 "$stage/src/lib/sanita/$file" "$app/src/lib/sanita/$file"
done

cd "$app"
if ! npm run build; then
  for file in \
    region-cities.ts \
    maps-discovery.ts \
    national-discovery-jobs.ts \
    playwright-maps.ts
  do
    install -m 0644 "$backup/src/lib/sanita/$file" "$app/src/lib/sanita/$file"
  done
  npm run build
  echo "DEPLOY_ROLLED_BACK"
  exit 1
fi

pm2 restart leadsniper-ui --update-env
bash /tmp/codex-deploy-territory-runner-repair.sh

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
curl -fsS http://127.0.0.1:3000/api/sanita/national-discovery?region=Calabria >/dev/null
printf 'BACKUP=%s\nTERRITORY_NATIONAL_DEPLOY_OK\n' "$backup"
