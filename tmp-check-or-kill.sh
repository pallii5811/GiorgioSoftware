#!/bin/bash
WP=$(pgrep -n -f 'loader.mjs /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker' || true)
echo WP=$WP
ps -o etime,pcpu,pid,cmd -p "$WP" 2>/dev/null || true
date -u
python3 /tmp/tmp-peek16.py | head -5
# if worker > 3 min on empty frontier finalize, kill
if [ -n "$WP" ]; then
  etime=$(ps -o etimes= -p "$WP" | tr -d ' ')
  echo etimes=$etime
  if [ "${etime:-0}" -gt 180 ]; then
    echo killing_hung
    kill -TERM "$WP" || true
    sleep 6
  fi
fi
python3 /tmp/tmp-peek16.py | head -35
tail -n 8 /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log
