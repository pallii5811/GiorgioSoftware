#!/usr/bin/env bash
# Ricompila la UI Next.js e riavvia pm2 SOLO se il build riesce (no downtime su build rotto).
cd /opt/leadsniper

export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'

echo "[rebuild] start $(date -u +%H:%M:%S)"
if npm run build > /opt/leadsniper/build.log 2>&1; then
  echo "[rebuild] build OK, restart pm2"
  pm2 restart leadsniper-ui --update-env
  echo "[rebuild] done $(date -u +%H:%M:%S)"
else
  echo "[rebuild] BUILD FAILED — UI invariata (nessun downtime). Vedi build.log"
  tail -n 25 /opt/leadsniper/build.log
fi
