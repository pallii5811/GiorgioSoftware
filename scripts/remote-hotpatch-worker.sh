#!/usr/bin/env bash
# Hot-patch worker identity fix only; do NOT kill in-flight probe if still useful.
# If probe parent still running, leave it; only copy worker for next spawn.
set -uo pipefail
APP=/opt/leadsniper-revalidate/app
cp -f /tmp/production-revalidate-sanita-worker.mjs "$APP/scripts/"
sha256sum "$APP/scripts/production-revalidate-sanita-worker.mjs" /tmp/production-revalidate-sanita-worker.mjs
echo "worker_patched_for_next_spawn"

# frontier columns + pdf progress
python3 - <<'PY'
import sqlite3
p="/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqkld5t300av108e5rrr47s9-1784581423685.sqlite"
c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
cols=[r[1] for r in c.execute("pragma table_info(CrawlFrontierNode)").fetchall()]
print("cols", cols)
# guess state-like
for col in cols:
  if col.lower() in ("state","status","lifecycle","nodeState","processingState".lower()):
    print(col, c.execute(f"select {col}, count(*) from CrawlFrontierNode group by 1").fetchall()[:20])
print("resourceType", c.execute("select resourceType, count(*) from CrawlFrontierNode group by 1").fetchall())
# sample
print("sample", c.execute(f"select {','.join(cols[:8])} from CrawlFrontierNode limit 3").fetchall())
c.close()
PY

# probe still alive?
pgrep -af 'timeout 2700.*production-revalidate-sanita-v3' || echo "probe_parent_gone"
LOG=$(ls -t /opt/leadsniper-revalidate/logs/probe-3-*.log 2>/dev/null | head -1)
wc -c "$LOG"
grep -E 'lead_done|lead_error|revalidate_v3_end|FATAL|heap' "$LOG" | tail -20 || true
