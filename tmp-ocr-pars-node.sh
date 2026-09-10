#!/bin/bash
set -euo pipefail
export PDFTOPPM_PATH=/usr/bin/pdftoppm
export TESSDATA_PREFIX=/opt/leadsniper-revalidate/app/.tesseract-cache
export OCR_ENABLED=1
which tesseract || ls /usr/bin/tesseract* || true
ls /tmp/pars6*.png
cd /opt/leadsniper-revalidate/app
npx --yes tsx - <<'JS'
import fs from 'fs';
import { extractPdfFullText } from './src/lib/sanita/ocr.ts';
const buf = fs.readFileSync('/tmp/PARS_Malzoni-Research-Hospital_2026.pdf');
const r = await extractPdfFullText(buf);
const t = r.text || '';
console.log(JSON.stringify({ status: r.status, len: t.length, hasPhrase: /opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione/i.test(t) }));
const idx = t.search(/autoassicurazione/i);
console.log('snip', t.slice(Math.max(0, idx-120), idx+200));
JS
python3 <<'PY'
import json
from pathlib import Path
ids=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/ids.json').read_text())['ids']
print('IN_TARGET_radio', 'cmqklex5g00b6108ejom1shk0' in ids)
print('IN_TARGET_research', 'cmqktyimz000i111hygme29nh' in ids)
for lid in ids:
  p=Path(f'/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results/{lid}.json')
  if not p.exists():
    continue
  j=json.loads(p.read_text())
  ev=(j.get('fullEvidence') or j.get('evidence') or '')[:80]
  if lid=='cmqklex5g00b6108ejom1shk0' or 'Malzoni' in str(j.get('companyName','')):
    print(lid, j.get('processingState'), j.get('companyName'), j.get('reasonCode'))
PY
