#!/bin/bash
set -euo pipefail
systemctl stop giorgio-revalidate || true
echo "giorgio=$(systemctl is-active giorgio-revalidate || true)"
APP=/opt/leadsniper-revalidate/app
OUT=/opt/leadsniper-revalidate/data/stopship-retry11-rerun
SHA=$(cat "$APP/RELEASE_SHA" 2>/dev/null || true)
echo "RELEASE=$SHA"
python3 /tmp/final-close-two.py
# soft-restart targeted parent only if needed — preserve CP
pgrep -af 'stopship-retry11-rerun|production-revalidate-sanita-v3' | head -8 || true
