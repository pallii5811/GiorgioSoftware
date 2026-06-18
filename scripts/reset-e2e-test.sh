#!/usr/bin/env bash
set -euo pipefail
cd /opt/leadsniper

echo '== start pipeline =='
pm2 restart leadsniper-pipeline --update-env >/dev/null 2>&1 || true
sleep 4
if pgrep -f hetzner-full-pipeline >/dev/null 2>&1; then
  echo 'pipeline running: YES'
else
  echo 'pipeline running: NO (waiting 10s)'
  sleep 10
  if pgrep -f hetzner-full-pipeline >/dev/null 2>&1; then echo 'pipeline running after wait: YES'; else echo 'pipeline running after wait: NO'; fi
fi

echo '== call reset =='
RESP=$(curl -sS -X DELETE 'http://127.0.0.1:3000/api/sanita?region=Campania')
echo "$RESP" | head -c 220; echo

echo '== lock file during/after reset =='
if [ -f /opt/leadsniper/.reset.lock ]; then
  echo 'lock exists: YES'
  head -c 140 /opt/leadsniper/.reset.lock; echo
else
  echo 'lock exists: NO'
fi

echo '== wait up to 10s for lock release =='
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ ! -f /opt/leadsniper/.reset.lock ]; then
    echo "released after ${i}s"
    break
  fi
  sleep 1
done

echo '== ensure pipeline not duplicated =='
chains=$( (pgrep -fa 'loader.mjs scripts/hetzner-full-pipeline' 2>/dev/null || true) | wc -l)
echo "pipeline chains: $chains"

echo '== restart pipeline and check it starts =='
pm2 restart leadsniper-pipeline --update-env >/dev/null 2>&1 || true
sleep 5
if pgrep -f hetzner-full-pipeline >/dev/null 2>&1; then
  echo 'pipeline running after restart: YES'
else
  echo 'pipeline running after restart: NO (waiting 20s)'
  sleep 20
  if pgrep -f hetzner-full-pipeline >/dev/null 2>&1; then echo 'pipeline running after wait: YES'; else echo 'pipeline running after wait: NO'; fi
fi

echo '== done =='

