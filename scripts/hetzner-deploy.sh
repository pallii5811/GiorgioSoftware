#!/bin/bash
set -e
cd /opt
mkdir -p /opt/leadsniper-new
tar -xzf /root/leadsniper-deploy.tgz -C /opt/leadsniper-new
rsync -a --delete \
  --exclude=.env --exclude=.env.* --exclude='*.db' --exclude='*.db-*' \
  /opt/leadsniper-new/ /opt/leadsniper/
rm -rf /opt/leadsniper-new
cd /opt/leadsniper
npm ci
node scripts/prisma-smart.mjs
npm run build
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export NODE_ENV=production
pm2 delete leadsniper-ui 2>/dev/null || true
pm2 start npm --name leadsniper-ui --update-env -- run start
pm2 save
echo DEPLOY_OK
