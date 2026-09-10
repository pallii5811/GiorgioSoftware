#!/bin/bash
# Bootstrap Mirax backend on empty Hetzner (prod layout :8001)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo ">>> apt base"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip curl ca-certificates \
  build-essential git poppler-utils \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libpango-1.0-0 libcairo2 fonts-liberation 2>/dev/null \
  || apt-get install -y -qq python3 python3-venv python3-pip curl ca-certificates \
  build-essential git poppler-utils

# Chromium for Playwright
apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null || true
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  snap install chromium 2>/dev/null || true
fi

id -u worker >/dev/null 2>&1 || useradd -m -s /bin/bash worker
mkdir -p /home/worker/app/backend /home/worker/backups /home/worker/app/releases
chown -R worker:worker /home/worker

echo ">>> venv"
if [[ ! -x /home/worker/app/venv/bin/python ]]; then
  sudo -u worker python3 -m venv /home/worker/app/venv
fi
sudo -u worker /home/worker/app/venv/bin/pip install -U pip wheel setuptools -q

echo "BOOTSTRAP_OK"
python3 --version
/home/worker/app/venv/bin/python --version
ls -la /usr/bin/chrom* /snap/bin/chromium 2>/dev/null || true
