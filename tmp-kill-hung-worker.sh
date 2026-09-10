#!/bin/bash
set -euo pipefail
python3 /tmp/frontier-peek.py cmql4qrih | head -15
WP=$(pgrep -n -f 'loader.mjs /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker' || true)
echo WP=$WP
if [ -n "$WP" ]; then
  ps -o etime,pcpu,pid -p "$WP" || true
  kill -TERM "$WP" || true
  sleep 12
fi
python3 /tmp/tmp-peek16.py | head -40
tail -n 5 /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log
