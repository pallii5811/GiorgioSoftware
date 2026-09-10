#!/bin/bash
set -euo pipefail
# Single parent only: kill leftovers holding flock, then start once.
systemctl stop giorgio-revalidate || true
sleep 1
# Kill anything still on the parent lock / revalidate scripts (not UI).
pkill -f 'production-revalidate-sanita' || true
pkill -f 'revalidate.parent.lock' || true
# orphan chrome from killed workers
pkill -f 'chrome-headless' || true
sleep 2
# ensure lock file free
fuser -k /opt/leadsniper-revalidate/revalidate.parent.lock 2>/dev/null || true
sleep 1
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 5
systemctl is-active giorgio-revalidate
echo "PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
pgrep -af 'production-revalidate-sanita-v3' | head
# syntax smoke
cd /opt/leadsniper-revalidate/app && node --check scripts/production-revalidate-sanita-v3.mjs 2>&1 | head || true
tail -n 20 /opt/leadsniper-revalidate/logs/systemd-revalidate.log 2>/dev/null || journalctl -u giorgio-revalidate -n 15 --no-pager
