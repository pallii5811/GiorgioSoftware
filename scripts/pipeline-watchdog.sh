#!/usr/bin/env bash
# Watchdog: tiene viva la pipeline full-region.
# - Non avvia doppioni (lock file)
# - Auto-restart su crash
# - Log su /opt/leadsniper/pipeline.log e /opt/leadsniper/pipeline-watchdog.log
set -euo pipefail

cd /opt/leadsniper

LOCK=/opt/leadsniper/.pipeline.lock
RESET_LOCK=/opt/leadsniper/.reset.lock
LIVE_SCAN_LOCK=/opt/leadsniper/.live-scan.lock
LOG=/opt/leadsniper/pipeline.log
WDLOG=/opt/leadsniper/pipeline-watchdog.log

# Env safe per questa macchina (8GB + swap): evita OOM.
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

REGIONS=(Campania Veneto)

ts() { date -Iseconds; }

# flock: 9 = fd lock
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(ts)] already running" | tee -a "$WDLOG"
  exit 0
fi

echo "[$(ts)] watchdog start" | tee -a "$WDLOG"

# Stabilità: un SOLO scanner sul DB SQLite. Elimino eventuali pipeline/chromium
# orfani (es. avvii manuali precedenti) PRIMA di lanciare la nostra.
pkill -9 -f hetzner-full-pipeline 2>/dev/null || true
pkill -9 -f chrome-headless-shell 2>/dev/null || true
pkill -9 -f chromium 2>/dev/null || true
sleep 3

while true; do
  # Reset regione in corso: non avviare né tenere in vita la pipeline.
  while [ -f "$RESET_LOCK" ]; do
    # Auto-riparazione: se il lock resta appeso (crash a metà reset), dopo 10 minuti lo consideriamo stantio.
    if [ "$(find "$RESET_LOCK" -mmin +10 2>/dev/null | wc -l)" -gt 0 ]; then
      echo "[$(ts)] stale reset lock detected, removing" | tee -a "$WDLOG"
      rm -f "$RESET_LOCK" || true
      break
    fi
    echo "[$(ts)] reset lock present, waiting" | tee -a "$WDLOG"
    sleep 2
  done
  # Scansione live dalla UI: ferma solo la pipeline batch, NON Chromium (Playwright UI).
  while [ -f "$LIVE_SCAN_LOCK" ]; do
    if [ "$(find "$LIVE_SCAN_LOCK" -mmin +360 2>/dev/null | wc -l)" -gt 0 ]; then
      echo "[$(ts)] stale live-scan lock detected, removing" | tee -a "$WDLOG"
      rm -f "$LIVE_SCAN_LOCK" || true
      break
    fi
    pkill -9 -f hetzner-full-pipeline 2>/dev/null || true
    echo "[$(ts)] live UI scan active, waiting" | tee -a "$WDLOG"
    sleep 5
  done
  echo "[$(ts)] pipeline start" | tee -a "$WDLOG"
  # pm2 gestisce il processo: niente setsid/nohup qui.
  npx tsx scripts/hetzner-full-pipeline.mjs "${REGIONS[@]}" >>"$LOG" 2>&1
  code=$?
  echo "[$(ts)] pipeline exit code=$code" | tee -a "$WDLOG"
  # Backoff breve per non martellare in loop.
  sleep 15
done

