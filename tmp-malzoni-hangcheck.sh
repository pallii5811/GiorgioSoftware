#!/bin/bash
set -euo pipefail
echo "=== procs ==="
ps -eo pid,etime,cmd | grep -E 'production-revalidate|tsx.*worker' | grep -v grep
echo "=== curl assicurazione ==="
curl -sI -m 15 "http://www.radiosurgerymalzoni.it/assicurazione" | head -5 || true
curl -sI -m 15 "http://www.radiosurgerymalzoni.it/assicurazione-rct" | head -5 || true
curl -sI -m 15 "http://www.radiosurgerymalzoni.it/it/societa-trasparente" | head -5 || true
echo "=== worker fd / stack hint ==="
WP=$(pgrep -f 'production-revalidate-sanita-worker.mjs' | head -1 || true)
echo "worker_pid=$WP"
if [[ -n "${WP:-}" ]]; then
  ls -l /proc/$WP/fd 2>/dev/null | head -30 || true
  timeout 2 strace -p "$WP" 2>&1 | head -40 || true
fi
echo "=== log size / mtime ==="
ls -la /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log
tail -n 5 /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log
