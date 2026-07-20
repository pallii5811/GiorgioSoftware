#!/usr/bin/env bash
# Blue/green deploy on Hetzner — prepare parallel release, health-check, optional switch.
# Usage on server:
#   RELEASE_TGZ=/root/giorgio-release.tgz RELEASE_SHA=... bash scripts/hetzner-bluegreen-deploy.sh prepare
#   bash scripts/hetzner-bluegreen-deploy.sh switch
#   bash scripts/hetzner-bluegreen-deploy.sh rollback
set -euo pipefail

APP_BLUE=/opt/leadsniper
APP_GREEN=/opt/leadsniper-green
PORT_GREEN=${PORT_GREEN:-3001}
RELEASE_TGZ=${RELEASE_TGZ:-/root/giorgio-release.tgz}
RELEASE_SHA=${RELEASE_SHA:-unknown}
CMD=${1:-prepare}

health() {
  local base=$1
  curl -sf --max-time 20 "$base/api/sanita?region=Campania" >/tmp/health-sanita.json
  curl -sf --max-time 20 "$base/api/gare" >/tmp/health-gare.json || true
  python3 - <<'PY'
import json,sys
j=json.load(open("/tmp/health-sanita.json"))
assert j.get("success") is True or "data" in j, j
print("HEALTH_OK")
PY
}

case "$CMD" in
  prepare)
    mkdir -p "$APP_GREEN"
    tar -xzf "$RELEASE_TGZ" -C "$APP_GREEN"
    # preserve env + never overwrite live DB
    if [ -f "$APP_BLUE/.env" ] && [ ! -f "$APP_GREEN/.env" ]; then
      cp -a "$APP_BLUE/.env" "$APP_GREEN/.env"
    fi
    cd "$APP_GREEN"
    npm ci
    node scripts/prisma-smart.mjs
    npm run build
    # shadow DB for green smoke — copy from latest shadow if present
    LATEST_SHADOW=$(ls -1t /opt/leadsniper/shadow/giorgio-shadow-*.db 2>/dev/null | head -1 || true)
    if [ -n "$LATEST_SHADOW" ]; then
      cp -a "$LATEST_SHADOW" "$APP_GREEN/prisma/shadow-smoke.db"
      export DATABASE_URL="file:$APP_GREEN/prisma/shadow-smoke.db"
    else
      export DATABASE_URL="file:$APP_BLUE/prisma/dev.db"
    fi
    export SCAN_ENGINE_LOCAL=1
    export OCR_ENABLED=1
    export POLICY_EXHAUSTIVE=1
    export SCAN_FAST=0
    export NODE_ENV=production
    export PORT=$PORT_GREEN
    echo "$RELEASE_SHA" > "$APP_GREEN/RELEASE_SHA"
    pm2 delete leadsniper-green 2>/dev/null || true
    pm2 start npm --name leadsniper-green --update-env -- run start -- -H 127.0.0.1 -p "$PORT_GREEN"
    sleep 5
    health "http://127.0.0.1:$PORT_GREEN"
    echo PREPARE_OK green=$APP_GREEN sha=$RELEASE_SHA port=$PORT_GREEN
    ;;
  switch)
    # Point blue to green tree via symlink swap pattern: rsync green→blue excluding db/env
    test -f "$APP_GREEN/RELEASE_SHA"
    rsync -a --delete \
      --exclude=.env --exclude=.env.* --exclude='*.db' --exclude='*.db-*' \
      --exclude=backups --exclude=shadow --exclude=data/revalidation \
      "$APP_GREEN/" "$APP_BLUE/"
    cd "$APP_BLUE"
    export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
    export SCAN_ENGINE_LOCAL=1
    export OCR_ENABLED=1
    export POLICY_EXHAUSTIVE=1
    export SCAN_FAST=0
    export NODE_ENV=production
    pm2 restart leadsniper-ui --update-env
    sleep 4
    health "http://127.0.0.1:3000"
    echo SWITCH_OK sha=$(cat "$APP_BLUE/RELEASE_SHA" 2>/dev/null || echo unknown)
    ;;
  rollback)
    PREV=$(ls -1t /opt/leadsniper/backups/code-release-*.tgz 2>/dev/null | head -1 || true)
    if [ -z "$PREV" ]; then
      echo "No previous code release tarball"; exit 2
    fi
    tar -xzf "$PREV" -C "$APP_BLUE" --exclude='prisma/*.db*'
    cd "$APP_BLUE" && npm ci && node scripts/prisma-smart.mjs && npm run build
    pm2 restart leadsniper-ui --update-env
    health "http://127.0.0.1:3000"
    echo ROLLBACK_OK from=$PREV
    ;;
  *)
    echo "usage: $0 prepare|switch|rollback"; exit 2
    ;;
esac
