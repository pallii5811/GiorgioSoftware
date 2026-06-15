#!/usr/bin/env bash
# Avvia l'app completa per il cliente (UI + scansione Playwright).
# Esegui su Hetzner: bash scripts/hetzner-start-ui.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_ENV=production
export POLICY_EXHAUSTIVE=1
export OCR_ENABLED=1
export PORT="${PORT:-3000}"

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

npm ci
npx playwright install chromium
npx tsx scripts/download-tessdata.mjs 2>/dev/null || true
npx prisma generate
npx prisma db push
npm run build

pm2 delete leadsniper-ui 2>/dev/null || true
pm2 start npm --name leadsniper-ui -- run start -- -H 0.0.0.0 -p "$PORT"
pm2 save

echo ""
echo "✅ App cliente online: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):$PORT"
echo "   Scansiona Veneto/Campania funziona da questo URL (non da Vercel)."
