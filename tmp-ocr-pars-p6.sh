#!/bin/bash
set -euo pipefail
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export OCR_ENABLED=1
# OCR page 6 via pdftoppm + tesseract
pdftoppm -f 6 -l 6 -png /tmp/PARS_Malzoni-Research-Hospital_2026.pdf /tmp/pars6
ls -la /tmp/pars6*.png
tesseract /tmp/pars6-1.png /tmp/pars6-ocr -l ita+eng 2>/dev/null || tesseract /tmp/pars6-1.png /tmp/pars6-ocr -l eng
echo '---OCR PAGE6---'
cat /tmp/pars6-ocr.txt
python3 <<'PY'
import json
from pathlib import Path
ids=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/ids.json').read_text())['ids']
print('IN_TARGET', 'cmqklex5g00b6108ejom1shk0' in ids, 'cmqktyimz000i111hygme29nh' in ids)
print('IDS', ids)
# targeted results states for any malzoni
for lid in ids:
  p=Path(f'/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results/{lid}.json')
  if not p.exists():
    continue
  j=json.loads(p.read_text())
  name=j.get('companyName') or j.get('leadName') or ''
  if 'malzoni' in str(name).lower() or 'malzoni' in lid or lid in ('cmqklex5g00b6108ejom1shk0','cmqktyimz000i111hygme29nh'):
    print(lid, name, j.get('processingState'), j.get('reasonCode'))
PY
