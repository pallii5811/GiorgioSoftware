#!/bin/bash
set -euo pipefail
python3 <<'PY'
import sqlite3
con=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
for lid in ('cmqklex5g00b6108ejom1shk0','cmqktyimz000i111hygme29nh'):
  r=con.execute('select id,companyName,website,city,piva,phone,address from Lead where id=?',(lid,)).fetchone()
  print(r)
PY
# full ocr phrase
python3 - <<'PY'
from pathlib import Path
t=Path('/tmp/pars6-ocr.txt').read_text(errors='ignore')
import re
m=re.search(r'.{0,60}autoassicurazione.{0,40}', t, re.I)
print('MATCH', m.group(0) if m else None)
print('HAS_FULL', bool(re.search(r'opera\s+sotto\s+il\s+regime\s+di\s+autoassicurazione', t, re.I)))
# show end of text
print('TAIL', t[-400:])
PY
