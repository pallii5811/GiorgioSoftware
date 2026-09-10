#!/bin/bash
set -euo pipefail

# Scale Mirax user workers to 6 total (keep existing 1+2, add 3..6). Backlog unchanged.
TEMPLATE='[Unit]
Description=Mirax Worker User %N
After=network.target mirax-audit-api.service

[Service]
Type=simple
User=worker
WorkingDirectory=/home/worker/app
Environment=PATH=/snap/bin:/home/worker/app/venv/bin:/usr/bin
Environment=PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
Environment=CHROMIUM_PATH=/snap/bin/chromium
Environment=PYTHONPATH=/home/worker/app/backend
EnvironmentFile=/home/worker/app/backend/.env
ExecStart=/home/worker/app/venv/bin/python /home/worker/app/backend/worker_supabase.py --mode user --cooldown 2 --user-recent-minutes 0
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
'

for n in 3 4 5 6; do
  unit="/etc/systemd/system/mirax-worker-user-${n}.service"
  # Description with number
  cat >"$unit" <<EOF
[Unit]
Description=Mirax Worker User ${n}
After=network.target mirax-audit-api.service

[Service]
Type=simple
User=worker
WorkingDirectory=/home/worker/app
Environment=PATH=/snap/bin:/home/worker/app/venv/bin:/usr/bin
Environment=PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
Environment=CHROMIUM_PATH=/snap/bin/chromium
Environment=PYTHONPATH=/home/worker/app/backend
EnvironmentFile=/home/worker/app/backend/.env
ExecStart=/home/worker/app/venv/bin/python /home/worker/app/backend/worker_supabase.py --mode user --cooldown 2 --user-recent-minutes 0
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  echo "wrote $unit"
done

systemctl daemon-reload
systemctl enable --now mirax-worker-user-3 mirax-worker-user-4 mirax-worker-user-5 mirax-worker-user-6
sleep 2

echo "=== STATUS ==="
systemctl is-active \
  mirax-worker-user \
  mirax-worker-user-2 \
  mirax-worker-user-3 \
  mirax-worker-user-4 \
  mirax-worker-user-5 \
  mirax-worker-user-6 \
  mirax-worker-backlog \
  mirax-audit-api

echo "=== UNITS ==="
systemctl list-units 'mirax-worker*' --no-pager

echo "=== PIDS ==="
ps -u worker -o pid,cmd | grep -E 'worker_supabase|uvicorn' | grep -v grep || true
