#!/bin/bash
set -euo pipefail
ls -la /tmp/PARS_Malzoni-Research-Hospital_2026.pdf || true
# re-download if needed
URL='https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf'
curl -sL -m 90 -A 'Mozilla/5.0' -o /tmp/PARS_Malzoni-Research-Hospital_2026.pdf "$URL"
ls -la /tmp/PARS_Malzoni-Research-Hospital_2026.pdf
sha256sum /tmp/PARS_Malzoni-Research-Hospital_2026.pdf
pdftotext -f 6 -l 6 /tmp/PARS_Malzoni-Research-Hospital_2026.pdf /tmp/pars-p6.txt || true
head -80 /tmp/pars-p6.txt
python3 <<'PY'
import sqlite3
con=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
row=con.execute("select id,companyName,website,city from Lead where id=?", ("cmqklex5g00b6108ejom1shk0",)).fetchone()
print("LEAD", row)
for r in con.execute("select id,companyName,website from Lead where lower(companyName) like '%malzoni%' limit 30"):
    print(r)
PY
