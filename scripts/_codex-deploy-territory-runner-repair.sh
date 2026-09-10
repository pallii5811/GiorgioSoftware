#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
staged="/tmp/codex-territory-runner-repair/sanita-national-discovery-runner.mjs"
job_id="b0281f30-1225-47d1-917c-a0ad02b9ea28"
job_file="$app/data/sanita-national-discovery/$job_id.json"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$app/backups/territory-runner-repair-$stamp"

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
test -f "$staged"
mkdir -p "$backup"
cp "$app/scripts/sanita-national-discovery-runner.mjs" "$backup/"

old_pid="$(python3 - "$job_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("pid") or "")
PY
)"
if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
  old_pgid="$(ps -o pgid= -p "$old_pid" | tr -d ' ')"
  kill -TERM -- "-$old_pgid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$old_pid" 2>/dev/null; then
    kill -KILL -- "-$old_pgid" 2>/dev/null || true
  fi
fi

install -m 0644 "$staged" "$app/scripts/sanita-national-discovery-runner.mjs"
cd "$app"
node --check scripts/sanita-national-discovery-runner.mjs
export DATABASE_URL="file:/opt/leadsniper/prisma/dev.db"
export SCAN_ENGINE_LOCAL=1
export NATIONAL_DISCOVERY_JOB_ID="$job_id"
export MAPS_CITY_BUDGET_MS=120000
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export NODE_ENV=production
setsid npx tsx scripts/sanita-national-discovery-runner.mjs "$job_id" \
  >"$app/logs/territory-$job_id.log" 2>&1 </dev/null &
sleep 12

python3 - "$job_file" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    job = json.load(handle)
assert job["status"] == "running", job
assert job.get("pid"), job
os.kill(int(job["pid"]), 0)
print("JOB_OK", job["pid"], job["progress"])
PY
grep -q '"event":"territory_frontier_repaired"' "$app/logs/territory-$job_id.log"
test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
printf 'BACKUP=%s\nTERRITORY_RUNNER_REPAIR_OK\n' "$backup"
