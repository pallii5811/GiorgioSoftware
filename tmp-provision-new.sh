#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo ">>> Aggiornamento sistema..."
apt-get update -qq
apt-get install -y -qq git curl build-essential ca-certificates python3

echo ">>> Node.js 22..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v
npm -v

echo ">>> Playwright chromium deps..."
npx --yes playwright install-deps chromium 2>/dev/null || true

echo ">>> Poppler..."
apt-get install -y -qq poppler-utils
command -v pdftoppm
pdftoppm -v 2>&1 | head -1 || true

mkdir -p /opt/leadsniper /opt/leadsniper-revalidate
echo "PROVISION_OK"
