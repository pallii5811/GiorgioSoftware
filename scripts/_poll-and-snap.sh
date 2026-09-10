#!/bin/bash
set -euo pipefail
pkill -f _poll-retry20-gate.py || true
sleep 1
nohup env GATE_TIMEOUT_S=3600 python3 -u /tmp/_poll-retry20-gate.py >/tmp/retry20-gate.log 2>&1 &
echo "POLL=$!"
sleep 2
bash /tmp/_gate-snap.sh
