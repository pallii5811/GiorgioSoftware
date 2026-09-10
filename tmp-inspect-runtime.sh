#!/bin/bash
set -euo pipefail
echo "=== UNIT ==="
systemctl cat giorgio-revalidate 2>/dev/null | head -90 || true
echo "enabled=$(systemctl is-enabled giorgio-revalidate 2>/dev/null || true)"
echo "active=$(systemctl is-active giorgio-revalidate 2>/dev/null || true)"
echo "=== DB ==="
sha256sum /opt/leadsniper/prisma/dev.db
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
print('HC', c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0])
PY
echo "=== PATHS ==="
ls -la /opt/leadsniper-revalidate/data/revalidation/checkpoint.json 2>/dev/null || echo NO_CP
cat /opt/leadsniper/RELEASE_SHA 2>/dev/null || true
test -d /opt/leadsniper-revalidate/app/.tesseract-cache && echo TESS_OK || echo TESS_MISS
which tesseract || true
ls -la /snap/bin/chromium 2>/dev/null || true
echo "=== DROPINS ==="
ls -la /etc/systemd/system/giorgio-revalidate.service.d/ 2>/dev/null || true
