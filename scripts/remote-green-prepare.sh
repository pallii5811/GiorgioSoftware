#!/usr/bin/env bash
set -euo pipefail
SRC=/opt/leadsniper-green-src
DST=/opt/leadsniper-green
SHA=$(git -C "$SRC" rev-parse HEAD)
rm -rf "$DST"
mkdir -p "$DST"
rsync -a --delete --exclude=.git "$SRC/" "$DST/"
if [ -f /opt/leadsniper/.env ]; then
  cp -a /opt/leadsniper/.env "$DST/.env"
fi
echo "$SHA" > "$DST/RELEASE_SHA"
cd "$DST"
npm ci
node scripts/prisma-smart.mjs
npm run build
LATEST=$(ls -1t /opt/leadsniper/shadow/giorgio-shadow-*.db | head -1)
cp -a "$LATEST" "$DST/prisma/shadow-smoke.db"
export DATABASE_URL="file:$DST/prisma/shadow-smoke.db"
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export NODE_ENV=production
export PORT=3001
pm2 delete leadsniper-green 2>/dev/null || true
pm2 start npm --name leadsniper-green --update-env --cwd "$DST" -- run start -- -H 127.0.0.1 -p 3001
sleep 10
curl -sf --max-time 40 "http://127.0.0.1:3001/api/sanita?region=Campania" > /tmp/green-health.json
python3 - <<'PY'
import json
j=json.load(open("/tmp/green-health.json"))
assert "data" in j or j.get("success") is True
print("GREEN_HEALTH_OK", "keys", list(j.keys())[:8])
PY
echo "GREEN_UP sha=$SHA"
pm2 list
