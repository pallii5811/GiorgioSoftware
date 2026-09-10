#!/bin/bash
set -euo pipefail
echo "=== FREEZE ==="
systemctl stop giorgio-revalidate || true
systemctl is-active giorgio-revalidate || true
echo "prod-like processes:"
pgrep -af 'data/revalidation/checkpoint|giorgio-revalidate.service' | head -10 || true
echo "targeted/workers:"
pgrep -af 'stopship-retry11-rerun|production-revalidate-sanita' | head -20 || true
# orphan chromium not owned by targeted — leave targeted chromium alone for now
python3 /tmp/fase0_baseline.py
