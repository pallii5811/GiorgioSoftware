#!/usr/bin/env bash
set -uo pipefail
# Ensure single reval worker + systemd unit for auto-resume.
pkill -f production-revalidate-sanita-v2 2>/dev/null || true
sleep 2
pkill -9 -f production-revalidate-sanita-v2 2>/dev/null || true

cat >/etc/systemd/system/giorgio-revalidate.service <<'UNIT'
[Unit]
Description=Giorgio Sanita shadow revalidation (resumable)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/leadsniper-revalidate/app
Environment=GIT_HEAD_FILE=/opt/leadsniper-revalidate/app/RELEASE_SHA
Environment=DATABASE_URL=file:/opt/leadsniper-revalidate/shadow-revalidate.db
Environment=SCAN_ENGINE_LOCAL=1
Environment=OCR_ENABLED=1
Environment=POLICY_EXHAUSTIVE=1
Environment=SCAN_FAST=0
Environment=STAGING_MODE=true
Environment=DISABLE_LIVE_DB=true
Environment=DISABLE_EMAILS=true
Environment=REVALIDATE_CONCURRENCY=1
Environment=REVALIDATE_DUAL_HOT=1
Environment=REVALIDATE_CHECKPOINT=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
Environment=TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
Environment=FRONTIER_DB_PATH=/opt/leadsniper-revalidate/data/revalidation/frontiers/boot.sqlite
Environment=PDFTOPPM_PATH=/usr/bin/pdftoppm
ExecStartPre=/bin/bash -c 'export GIT_HEAD=$(cat /opt/leadsniper-revalidate/app/RELEASE_SHA); export RELEASE_SHA=$GIT_HEAD; true'
ExecStart=/bin/bash -c 'export GIT_HEAD=$(cat RELEASE_SHA); export RELEASE_SHA=$GIT_HEAD; exec npx tsx scripts/production-revalidate-sanita-v2.mjs'
Restart=on-failure
RestartSec=30
StandardOutput=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
StandardError=append:/opt/leadsniper-revalidate/logs/systemd-revalidate.log
Nice=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable giorgio-revalidate.service
systemctl restart giorgio-revalidate.service
sleep 8
systemctl is-active giorgio-revalidate.service
tail -n 5 /opt/leadsniper-revalidate/logs/systemd-revalidate.log || true
python3 - <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print(json.dumps({"done":len(cp.get("done") or {}),"stats":cp.get("stats"),"sha":cp.get("testedCodeSha")},indent=2))
PY
