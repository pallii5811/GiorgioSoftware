#!/bin/bash
set -euo pipefail
find /opt/leadsniper /opt/leadsniper-revalidate/app -name '*scan*.pdf' 2>/dev/null | head || true
cd /opt/leadsniper
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export OCR_ENABLED=1
npx --yes tsx scripts/tmp-ocr-scanned-e2e.mjs || true
# also try clotilde from data if any
python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('877_term', len(c.get('terminal') or {}))
print('877_retry', len(c.get('retryQueue') or {}))
print('877_ip', len(c.get('inProgress') or {}))
print('active_check')
PY
systemctl is-active giorgio-revalidate
# confirm remote=runtime
echo REMOTE_RUNTIME=$(cat /opt/leadsniper-revalidate/app/RELEASE_SHA)
