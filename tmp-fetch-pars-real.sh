#!/bin/bash
set -euo pipefail
URL='https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf'
curl -sL -m 60 -A 'Mozilla/5.0' -o /tmp/PARS_Malzoni-Research-Hospital_2026.pdf "$URL"
file /tmp/PARS_Malzoni-Research-Hospital_2026.pdf
sha256sum /tmp/PARS_Malzoni-Research-Hospital_2026.pdf
pdftotext -f 6 -l 6 /tmp/PARS_Malzoni-Research-Hospital_2026.pdf - | tee /tmp/pars-p6.txt | head -60
# lead identity
python3 - <<'PY'
import sqlite3
con=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
row=con.execute("select id,companyName,website,city from Lead where id='cmqklex5g00b6108ejom1shk0'").fetchone()
print('LEAD', row)
# also search malzoni research
for r in con.execute("select id,companyName,website from Lead where companyName like '%Malzoni%' limit 20"):
  print(r)
PY
