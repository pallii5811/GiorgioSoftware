#!/usr/bin/env bash
set -euo pipefail

systemctl stop giorgio-revalidate
ts="$(date -u +%Y%m%dT%H%M%SZ)"
snap="/opt/leadsniper-revalidate/snapshots/codex-pre-fix-$ts"
mkdir -p "$snap"
cp -a /opt/leadsniper-revalidate/data/revalidation/checkpoint.json "$snap/checkpoint.json"
cp -a /opt/leadsniper-revalidate/data/revalidation/results "$snap/results"
cp -a /etc/systemd/system/giorgio-revalidate.service "$snap/giorgio-revalidate.service"
cp -a /etc/systemd/system/giorgio-revalidate.service.d "$snap/service.d"
cp -a /opt/leadsniper-revalidate/app/RELEASE_SHA "$snap/RELEASE_SHA" 2>/dev/null || true
mkdir -p "$snap/scripts"
cp -a /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-v3.mjs "$snap/scripts/"
cp -a /opt/leadsniper-revalidate/app/scripts/revalidate-checkpoint-v3.mjs "$snap/scripts/"
systemctl is-active giorgio-revalidate || true
pgrep -af 'production-revalidate-sanita|chrome-headless|/snap/chromium' || true
echo "SNAP=$snap"
