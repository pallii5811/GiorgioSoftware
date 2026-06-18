#!/usr/bin/env bash
# Avvia la pipeline batch full-region in background, sopravvive alla disconnessione SSH.
set -e
cd /opt/leadsniper

export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export OCR_JOB_TIMEOUT_MS=600000
export SCAN_LEAD_MAX_MS=1500000
export MAPS_CITY_CONCURRENCY=2
export MAPS_CITY_BUDGET_MS=55000
export SCAN_CONCURRENCY=3
export DISCOVERY_CHUNK_MS=240000

REGIONS="${*:-Campania Veneto}"

# Evita doppioni: se gira gia', non rilanciare.
if pgrep -f hetzner-full-pipeline >/dev/null 2>&1; then
  echo "ALREADY_RUNNING"
  exit 0
fi

setsid nohup npx tsx scripts/hetzner-full-pipeline.mjs $REGIONS \
  > /opt/leadsniper/pipeline.log 2>&1 < /dev/null &

sleep 2
echo "LAUNCHED $(pgrep -f hetzner-full-pipeline | head -1)"
