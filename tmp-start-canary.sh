#!/bin/bash
set -euo pipefail
chmod +x /tmp/run-canary20.sh
nohup bash /tmp/run-canary20.sh >/opt/leadsniper-revalidate/data/stopship-canary20/nohup.out 2>&1 &
echo "PID:$!"
sleep 10
echo "===NOHUP==="
cat /opt/leadsniper-revalidate/data/stopship-canary20/nohup.out || true
echo "===LOG==="
head -n 50 /opt/leadsniper-revalidate/data/stopship-canary20/canary20.log || true
echo "===PROD==="
python3 /tmp/status-stopship.py
