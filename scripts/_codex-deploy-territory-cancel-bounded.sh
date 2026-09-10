#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
staged="/tmp/codex-territory-cancel-bounded"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$app/backups/territory-cancel-bounded-$stamp"

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
python3 - "$app/data/sanita-national-discovery" <<'PY'
import json
import pathlib
import sys

active = []
for path in pathlib.Path(sys.argv[1]).glob("*.json"):
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        continue
    if (
        job.get("status") in {"queued", "waiting_for_archive", "running"}
        and not job.get("cancelRequested")
    ):
        active.append((job.get("jobId"), job.get("status")))
assert not active, active
PY

mkdir -p "$backup/scripts" \
  "$backup/src/lib/sanita" \
  "$backup/src/app/api/sanita/national-discovery" \
  "$backup/src/components"
cp "$app/scripts/sanita-national-discovery-runner.mjs" "$backup/scripts/"
cp "$app/src/lib/sanita/national-discovery-jobs.ts" "$backup/src/lib/sanita/"
cp "$app/src/app/api/sanita/national-discovery/route.ts" \
  "$backup/src/app/api/sanita/national-discovery/"
cp "$app/src/components/sanita-leads.tsx" "$backup/src/components/"

install -m 0644 "$staged/sanita-national-discovery-runner.mjs" \
  "$app/scripts/sanita-national-discovery-runner.mjs"
install -m 0644 "$staged/national-discovery-jobs.ts" \
  "$app/src/lib/sanita/national-discovery-jobs.ts"
install -m 0644 "$staged/national-discovery-route.ts" \
  "$app/src/app/api/sanita/national-discovery/route.ts"
install -m 0644 "$staged/sanita-leads.tsx" \
  "$app/src/components/sanita-leads.tsx"

cd "$app"
node --check scripts/sanita-national-discovery-runner.mjs
npx tsx scripts/test-national-territory.mjs
npm run build
pm2 restart leadsniper-ui --update-env
sleep 5
curl -fsS --max-time 20 http://127.0.0.1:3000/api/sanita/national-discovery?region=Calabria \
  >/dev/null
test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
printf 'BACKUP=%s\nTERRITORY_CANCEL_BOUNDED_DEPLOY_OK\n' "$backup"
