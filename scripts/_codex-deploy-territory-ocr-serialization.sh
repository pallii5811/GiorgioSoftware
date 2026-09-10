#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
job_id="202e1e86-4269-4b27-b9d8-f6ed7567d9b1"
job_file="$app/data/sanita-national-discovery/$job_id.json"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$app/backups/territory-ocr-serialization-$stamp"

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
mkdir -p "$backup/scripts"
cp "$job_file" "$backup/"
cp "$app/scripts/sanita-national-discovery-runner.mjs" "$backup/scripts/"
cp "$app/scripts/test-national-territory.mjs" "$backup/scripts/"

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

install -m 0644 /tmp/sanita-national-discovery-runner.mjs.codex \
  "$app/scripts/sanita-national-discovery-runner.mjs"
install -m 0644 /tmp/test-national-territory.mjs.codex \
  "$app/scripts/test-national-territory.mjs"

cd "$app"
node --check scripts/sanita-national-discovery-runner.mjs
grep -Fq \
  'process.env.TERRITORY_SCAN_CONCURRENCY || process.env.SCAN_STREAM_CONCURRENCY || "1"' \
  scripts/sanita-national-discovery-runner.mjs
grep -Fq "mapsDiscoveryComplete || skipDiscovery" src/lib/sanita/scan-stream.ts

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
sleep 15

python3 - "$job_file" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    job = json.load(handle)
assert job["status"] not in {"failed", "cancelled"}, job
if job["status"] in {"queued", "waiting_for_archive", "running"}:
    assert job.get("pid"), job
    os.kill(int(job["pid"]), 0)
print("JOB_OK", job["status"], job.get("pid"), job["progress"])
PY

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
printf 'BACKUP=%s\nTERRITORY_OCR_SERIALIZATION_OK\n' "$backup"
