#!/usr/bin/env bash
# Deploy v3 scripts to revalidate tree + migrate checkpoint + restart systemd
set -uo pipefail
APP=/opt/leadsniper-revalidate/app
WORKDIR=/opt/leadsniper-revalidate
SRC=/tmp/giorgio-reval-v3

mkdir -p "$SRC"
cp -f /tmp/production-revalidate-sanita-v3.mjs "$SRC/"
cp -f /tmp/production-revalidate-sanita-worker.mjs "$SRC/"
cp -f /tmp/revalidate-checkpoint-v3.mjs "$SRC/"
cp -f /tmp/production-apply-revalidation.mjs "$SRC/"
cp -f /tmp/test-revalidation-v3.mjs "$SRC/" 2>/dev/null || true

# preserve checkpoint/results/shadow — only update scripts
cp -f "$SRC/production-revalidate-sanita-v3.mjs" "$APP/scripts/"
cp -f "$SRC/production-revalidate-sanita-worker.mjs" "$APP/scripts/"
cp -f "$SRC/revalidate-checkpoint-v3.mjs" "$APP/scripts/"
cp -f "$SRC/production-apply-revalidation.mjs" "$APP/scripts/"
cp -f "$SRC/production-revalidate-sanita-v3.mjs" /opt/leadsniper/scripts/ 2>/dev/null || true
cp -f "$SRC/production-revalidate-sanita-worker.mjs" /opt/leadsniper/scripts/ 2>/dev/null || true
cp -f "$SRC/revalidate-checkpoint-v3.mjs" /opt/leadsniper/scripts/ 2>/dev/null || true
cp -f "$SRC/production-apply-revalidation.mjs" /opt/leadsniper/scripts/ 2>/dev/null || true

# migrate checkpoint in place (node one-shot)
cd "$APP"
export DATABASE_URL="file:$WORKDIR/shadow-revalidate.db"
export REVALIDATE_CHECKPOINT="$WORKDIR/data/revalidation/checkpoint.json"
node --input-type=module -e '
import fs from "fs";
import { migrateCheckpointV2toV3, saveCheckpointAtomic } from "./scripts/revalidate-checkpoint-v3.mjs";
const CHECKPOINT=process.env.REVALIDATE_CHECKPOINT;
const RESULTS="/opt/leadsniper-revalidate/data/revalidation/results";
const raw=JSON.parse(fs.readFileSync(CHECKPOINT,"utf8"));
const sha=fs.readFileSync("./RELEASE_SHA","utf8").trim();
const mig=migrateCheckpointV2toV3(raw, RESULTS, sha);
saveCheckpointAtomic(CHECKPOINT, mig.checkpoint);
console.log(JSON.stringify({migratedRetry:mig.migrated,terminal:mig.terminal,retry:mig.retry,version:mig.checkpoint.version}));
'

# systemd unit → v3
cat >/etc/systemd/system/giorgio-revalidate.service <<'UNIT'
[Unit]
Description=Giorgio Sanita shadow revalidation v3 (isolated workers)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/leadsniper-revalidate/app
Environment=DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
Environment=SCAN_ENGINE_LOCAL=1
Environment=OCR_ENABLED=1
Environment=POLICY_EXHAUSTIVE=1
Environment=SCAN_FAST=0
Environment=STAGING_MODE=true
Environment=DISABLE_LIVE_DB=true
Environment=DISABLE_EMAILS=true
Environment=REVALIDATE_CONCURRENCY=2
Environment=REVALIDATE_DUAL_HOT=1
Environment=REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
Environment=TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
Environment=FRONTIER_DB_PATH=/opt/leadsniper-revalidate/data/revalidation/frontiers/boot.sqlite
Environment=PDFTOPPM_PATH=/usr/bin/pdftoppm
Environment=GIT_HEAD_FILE=/opt/leadsniper-revalidate/app/RELEASE_SHA
TimeoutStopSec=900
KillMode=mixed
KillSignal=SIGTERM
ExecStart=/bin/bash -c 'export GIT_HEAD=$(cat RELEASE_SHA); export RELEASE_SHA=$GIT_HEAD; exec npx tsx scripts/production-revalidate-sanita-v3.mjs'
Restart=on-failure
RestartSec=30
StandardOutput=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
StandardError=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
Nice=5
MemoryMax=6G

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl reset-failed giorgio-revalidate || true
systemctl restart giorgio-revalidate
sleep 12
systemctl is-active giorgio-revalidate
tail -n 30 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | tr -d '\000' | tail -n 30
python3 - <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print(json.dumps({
  "version": cp.get("version"),
  "terminal": len(cp.get("terminal") or {}),
  "retryQueue": len(cp.get("retryQueue") or {}),
  "inProgress": len(cp.get("inProgress") or {}),
  "sha": cp.get("testedCodeSha"),
}, indent=2))
PY
