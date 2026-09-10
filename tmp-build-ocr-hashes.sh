#!/bin/bash
set -euo pipefail
cd /opt/leadsniper-revalidate/app
echo "=== BUILD ==="
npm run build > /tmp/build-out.txt 2>&1 && echo BUILD_OK || { echo BUILD_FAIL; tail -40 /tmp/build-out.txt; exit 1; }
echo "=== OCR CONTRACT / SCANNED ==="
npx --yes tsx scripts/test-ocr-contract.mjs > /tmp/ocr-contract.txt 2>&1 || true
tail -40 /tmp/ocr-contract.txt
npx --yes tsx scripts/test-ocr-pdftoppm-resolver.mjs > /tmp/ocr-pdftoppm.txt 2>&1 || true
tail -40 /tmp/ocr-pdftoppm.txt
echo "=== HASHES ==="
python3 - <<'PY'
import hashlib
from pathlib import Path
for p in [
 '/opt/leadsniper/prisma/dev.db',
 '/opt/leadsniper-revalidate/data/revalidation/checkpoint.json',
 '/opt/leadsniper-revalidate/app/RELEASE_SHA',
]:
  b=Path(p).read_bytes() if not p.endswith('RELEASE_SHA') else Path(p).read_text().encode()
  if p.endswith('.json') or p.endswith('dev.db'):
    h=hashlib.sha256(Path(p).read_bytes()).hexdigest()
    print(p, h)
  else:
    print(p, Path(p).read_text().strip())
PY
systemctl is-active giorgio-revalidate || true
pgrep -af 'production-revalidate-sanita-v3' || echo 'targeted_stopped'
