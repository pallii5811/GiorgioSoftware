#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# LeadSniper — setup server Hetzner (Ubuntu 22.04/24.04)
# Esegui come root sulla VPS appena creata:
#   curl -fsSL ... | bash
# oppure: bash scripts/hetzner-provision.sh
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo ">>> Aggiornamento sistema..."
apt-get update -qq
apt-get install -y -qq git curl build-essential ca-certificates

echo ">>> Node.js 22..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v
npm -v

echo ">>> Dipendenze Playwright (Chromium)..."
npx --yes playwright install-deps chromium 2>/dev/null || true

echo ">>> Poppler (pdftoppm) + Tesseract deps for OCR scanned PDF..."
apt-get install -y -qq poppler-utils
command -v pdftoppm
pdftoppm -v 2>&1 | head -1 || true

echo ">>> Cartella app..."
APP_DIR="${APP_DIR:-/opt/leadsniper}"
mkdir -p "$APP_DIR"
echo "App dir: $APP_DIR"
echo ""
echo "✅ Base pronta. Prossimi passi:"
echo "   1. git clone <repo> $APP_DIR  (oppure rsync dal PC)"
echo "   2. cd $APP_DIR && npm ci"
echo "   3. npx playwright install chromium"
echo "   4. npx tsx scripts/download-tessdata.mjs"
echo "   5. npm run preflight:ocr   # must exit 0 (pdftoppm + tessdata)"
echo "   6. cp .env.example .env  → inserire TAVILY_API_KEY"
echo "   7. npx prisma db push"
echo "   8. bash scripts/hetzner-scan.sh   (batch veloce)"
echo "   9. npm run build && npm run start  (UI produzione)"
echo ""
echo "OCR: export PDFTOPPM_PATH=\$(command -v pdftoppm) se non in PATH"
