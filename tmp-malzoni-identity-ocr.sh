#!/bin/bash
set -euo pipefail
python3 <<'PY'
import sqlite3
con=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
for lid in ('cmqklex5g00b6108ejom1shk0','cmqktyimz000i111hygme29nh'):
  r=con.execute('select id,companyName,website,city,piva,phone from Lead where id=?',(lid,)).fetchone()
  print(r)
from pathlib import Path
import re
t=Path('/tmp/pars6-ocr.txt').read_text(errors='ignore')
m=re.search(r'.{0,80}autoassicurazione.{0,60}', t, re.I)
print('MATCH', m.group(0) if m else None)
print('HAS_FULL', bool(re.search(r'opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione', t, re.I)))
print('TAIL', repr(t[-500:]))
PY

# OCR radiosurgery scanned candidate
URL='https://www.radiosurgerymalzoni.it/wp-content/uploads/2025/06/SKMBT_C22425062512340.pdf'
curl -sL -m 60 -o /tmp/skmbt.pdf "$URL"
ls -la /tmp/skmbt.pdf
pdftoppm -f 1 -l 3 -png /tmp/skmbt.pdf /tmp/skmbt
ls /tmp/skmbt*.png | head
cd /opt/leadsniper-revalidate/app
npx --yes tsx scripts/tmp-ocr-page6c.mjs 2>/dev/null || true
# reuse worker on skmbt page
npx --yes tsx - <<'JS'
import fs from 'fs';
import { createWorker } from 'tesseract.js';
const cache='/opt/leadsniper-revalidate/app/.tesseract-cache';
const worker=await createWorker('ita+eng',1,{langPath:cache});
for (const p of ['/tmp/skmbt-1.png','/tmp/skmbt-2.png','/tmp/skmbt-3.png']) {
  if (!fs.existsSync(p)) continue;
  const {data}=await worker.recognize(p);
  const t=data.text||'';
  if (/autoassic|polizza|PARS|posizione assicurativa/i.test(t)) {
    console.log('HIT', p, t.replace(/\s+/g,' ').slice(0,400));
  } else {
    console.log('no', p, t.replace(/\s+/g,' ').slice(0,120));
  }
}
await worker.terminate();
JS
