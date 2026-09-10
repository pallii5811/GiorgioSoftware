#!/usr/bin/env bash
set -euo pipefail

app="/opt/leadsniper"
job_id="b0281f30-1225-47d1-917c-a0ad02b9ea28"
job_file="$app/data/sanita-national-discovery/$job_id.json"
frontier="/tmp/leadsniper-national-discovery-frontier/$job_id.sqlite"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$app/backups/cancel-territory-$stamp"

mkdir -p "$backup"
cp "$job_file" "$backup/"
cp "$frontier" "$backup/" 2>/dev/null || true

pid="$(python3 - "$job_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("pid") or "")
PY
)"
if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
fi

python3 - "$job_file" "$frontier" <<'PY'
import datetime
import json
import sqlite3
import sys

job_file, frontier = sys.argv[1:]
with open(job_file, encoding="utf-8") as handle:
    job = json.load(handle)
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
job.update(
    status="cancelled",
    pid=None,
    finishedAt=now,
    updatedAt=now,
    lastHeartbeatAt=now,
    cancelRequested=True,
    errorMessage=None,
)
job.setdefault("progress", {})["message"] = "Scansione annullata. Checkpoint conservato."
with open(job_file, "w", encoding="utf-8") as handle:
    json.dump(job, handle, ensure_ascii=False, indent=2)

try:
    con = sqlite3.connect(frontier)
    con.execute(
        """UPDATE CrawlRun
              SET state = CASE WHEN state = 'RUNNING' THEN 'PAUSED' ELSE state END,
                  workerLock = NULL"""
    )
    con.execute(
        """UPDATE CrawlFrontierNode
              SET state = 'RETRY_PENDING',
                  nextRetryAt = ?,
                  lastError = 'CANCELLED_SAFE_RESUME',
                  updatedAt = ?
            WHERE state = 'FETCHING'""",
        (now, now),
    )
    con.commit()
    con.close()
except Exception as error:
    print("FRONTIER_WARN", error)

print(json.dumps({
    "status": job["status"],
    "pid": job["pid"],
    "message": job["progress"]["message"],
}))
PY

test "$(systemctl is-active giorgio-revalidate || true)" = "inactive"
printf 'BACKUP=%s\nCANCEL_SAFE_OK\n' "$backup"
