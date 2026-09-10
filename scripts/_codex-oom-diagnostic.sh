#!/usr/bin/env bash
set -u

echo "=== MEMORY ==="
free -h
swapon --show
df -h / /opt/leadsniper-revalidate

echo "=== CGROUP ==="
systemctl show giorgio-revalidate \
  -p MemoryCurrent -p MemoryPeak -p MemoryMax -p MemorySwapMax -p OOMPolicy
control_group="$(systemctl show giorgio-revalidate -p ControlGroup --value)"
cat "/sys/fs/cgroup${control_group}/memory.events" 2>/dev/null || true
echo "=== SWAP EVENTS ==="
cat "/sys/fs/cgroup${control_group}/memory.swap.events" 2>/dev/null || true

echo "=== FRONTIER ==="
python3 - <<'PY'
import sqlite3

path = "/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqooitvu0062aa3vxoq0ebok-1785035062256.sqlite"
connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
print(connection.execute(
    "select resourceType, state, count(*) from CrawlFrontierNode group by 1, 2"
).fetchall())
print(connection.execute(
    "select state, count(*) from CrawlRun group by 1"
).fetchall())
connection.close()
PY
