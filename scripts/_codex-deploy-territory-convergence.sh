#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
staging="/tmp/codex-territory-convergence"
job_id="b0281f30-1225-47d1-917c-a0ad02b9ea28"
job_file="$app/data/sanita-national-discovery/$job_id.json"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$app/backups/territory-convergence-$stamp"
checkpoint="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
archive_worker="/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs"
archive_before="$(systemctl is-active giorgio-revalidate || true)"

test "$archive_before" = "inactive"
test -f "$job_file"
test -f "$staging/scripts/sanita-national-discovery-runner.mjs"
test -f "$staging/scripts/test-national-territory.mjs"
test -f "$staging/src/lib/sanita/scan-stream.ts"

mkdir -p "$backup/scripts" "$backup/src/lib/sanita"
cp "$app/scripts/sanita-national-discovery-runner.mjs" "$backup/scripts/"
cp "$app/scripts/test-national-territory.mjs" "$backup/scripts/"
cp "$app/src/lib/sanita/scan-stream.ts" "$backup/src/lib/sanita/"
sha256sum "$checkpoint" >"$backup/checkpoint.before.sha"
sha256sum "$archive_worker" >"$backup/archive-worker.before.sha"

old_pid="$(python3 - "$job_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("pid") or "")
PY
)"
if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
  old_pgid="$(ps -o pgid= -p "$old_pid" | tr -d ' ')"
  if [[ -n "$old_pgid" ]]; then
    kill -TERM -- "-$old_pgid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$old_pid" 2>/dev/null; then
      kill -KILL -- "-$old_pgid" 2>/dev/null || true
    fi
  fi
fi

install -m 0644 \
  "$staging/scripts/sanita-national-discovery-runner.mjs" \
  "$app/scripts/sanita-national-discovery-runner.mjs"
install -m 0644 \
  "$staging/scripts/test-national-territory.mjs" \
  "$app/scripts/test-national-territory.mjs"
install -m 0644 \
  "$staging/src/lib/sanita/scan-stream.ts" \
  "$app/src/lib/sanita/scan-stream.ts"

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
npm run build
pm2 restart leadsniper-ui --update-env

mkdir -p "$app/logs"
setsid npx tsx scripts/sanita-national-discovery-runner.mjs "$job_id" \
  >"$app/logs/territory-$job_id.log" 2>&1 </dev/null &

sleep 12

archive_after="$(systemctl is-active giorgio-revalidate || true)"
test "$archive_after" = "$archive_before"
sha256sum "$checkpoint" >"$backup/checkpoint.after.sha"
sha256sum "$archive_worker" >"$backup/archive-worker.after.sha"
diff -u "$backup/checkpoint.before.sha" "$backup/checkpoint.after.sha"
diff -u "$backup/archive-worker.before.sha" "$backup/archive-worker.after.sha"

python3 - "$job_file" <<'PY'
import json, os, sys, time
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    job = json.load(handle)
assert job["status"] == "running", job
assert job.get("pid"), job
os.kill(int(job["pid"]), 0)
print(
    "JOB_OK",
    job["pid"],
    job["progress"].get("structuresScanned"),
    job["progress"].get("certifiedResults"),
    job["progress"].get("message"),
)
PY

curl -fsS --max-time 30 \
  "http://127.0.0.1:3000/api/sanita/national-discovery?region=Calabria" \
  | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j["success"]; print("API_OK", len(j["regions"]))'

printf 'ARCHIVE_STATE=%s\nBACKUP=%s\nTERRITORY_CONVERGENCE_DEPLOY_OK\n' \
  "$archive_after" "$backup"
