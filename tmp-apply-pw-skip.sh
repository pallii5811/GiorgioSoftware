#!/bin/bash
set -euo pipefail
cp /tmp/crawl-slice-runner.ts /opt/leadsniper-revalidate/app/src/lib/sanita/
python3 /tmp/tmp-park-malzoni.py
WP=$(pgrep -n -f 'loader.mjs /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker' || true)
echo WP=$WP
if [ -n "${WP:-}" ]; then kill -TERM "$WP" || true; sleep 8; fi
echo 1c1b9e09d393d175e62f4991d7807d4549d8f67c > /opt/leadsniper-revalidate/app/RELEASE_SHA
python3 /tmp/tmp-peek16.py | head -40
tail -n 6 /opt/leadsniper-revalidate/data/stopship-retry11-rerun/targeted.log
