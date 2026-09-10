#!/bin/bash
set -euo pipefail
export PATH="/snap/bin:$PATH"
APP=/home/worker/app
BE=$APP/backend
VENV=$APP/venv

mkdir -p "$BE"
tar -xzf /tmp/mirax-backend-deploy.tgz -C "$BE"
install -m 0600 /tmp/mirax-backend.env "$BE/.env"
chown -R worker:worker "$APP"

echo ">>> pip install requirements"
sudo -u worker "$VENV/bin/pip" install -r "$BE/requirements.txt" -q

# Playwright browsers (optional if using system chromium)
sudo -u worker env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 "$VENV/bin/playwright" install-deps chromium 2>/dev/null || true
sudo -u worker env PLAYWRIGHT_BROWSERS_PATH=0 "$VENV/bin/playwright" install chromium 2>/dev/null || true

echo ">>> import check"
sudo -u worker bash -lc "cd '$BE' && set -a && source .env && set +a && '$VENV/bin/python' -c 'import worker_supabase; print(\"worker_ok\", bool(worker_supabase.app))'"

cat >/etc/systemd/system/mirax-audit-api.service <<'EOF'
[Unit]
Description=Mirax Audit/Worker API (FastAPI :8001)
After=network.target

[Service]
Type=simple
User=worker
WorkingDirectory=/home/worker/app/backend
Environment=PATH=/snap/bin:/home/worker/app/venv/bin:/usr/bin
Environment=PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium
Environment=CHROMIUM_PATH=/snap/bin/chromium
EnvironmentFile=/home/worker/app/backend/.env
ExecStart=/home/worker/app/venv/bin/uvicorn worker_supabase:app --host 0.0.0.0 --port 8001
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/mirax-worker-user.service <<'EOF'
[Unit]
Description=Mirax Worker User realtime
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

cat >/etc/systemd/system/mirax-worker-user-2.service <<'EOF'
[Unit]
Description=Mirax Worker User 2
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

cat >/etc/systemd/system/mirax-worker-backlog.service <<'EOF'
[Unit]
Description=Mirax Worker Backlog
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
ExecStart=/home/worker/app/venv/bin/python /home/worker/app/backend/worker_supabase.py --mode backlog --cooldown 20
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Open firewall if ufw present
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp || true
  ufw allow 8001/tcp || true
fi

systemctl daemon-reload
systemctl enable mirax-audit-api mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
systemctl restart mirax-audit-api
sleep 2
systemctl restart mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
sleep 3

echo "=== STATUS ==="
systemctl is-active mirax-audit-api mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
curl -sf http://127.0.0.1:8001/health || (journalctl -u mirax-audit-api -n 40 --no-pager; exit 1)
echo
ss -lntp | grep 8001 || true
echo DEPLOY_OK
