#!/bin/bash
python3 <<'PY'
import sqlite3
c=sqlite3.connect('/opt/leadsniper/prisma/dev.db')
hc="type='HEALTHCARE'"
total=c.execute(f"select count(*) from Lead where {hc}").fetchone()[0]
scanned=c.execute(f"select count(*) from Lead where {hc} and lastScannedAt is not null").fetchone()[0]
pending=total-scanned
# evidence/outcome signals
cols=[r[1] for r in c.execute('pragma table_info(Lead)')]
print('cols_sample', [x for x in cols if x.lower() in ('evidence','outcome','status','verdict','lastscannedat','companyname') or 'scan' in x.lower() or 'hot' in x.lower()][:20])
# try common fields
for col in ('evidence','outcome','status','verdict','processingState'):
  if col in cols:
    nonempty=c.execute(f"select count(*) from Lead where {hc} and {col} is not null and {col}!=''").fetchone()[0]
    print(col, 'nonempty', nonempty)
hot=c.execute(f"select count(*) from Lead where {hc} and (evidence like '%[V:HOT]%' or ifnull(outcome,'') like '%HOT%')").fetchone()[0]
pub=c.execute(f"select count(*) from Lead where {hc} and (evidence like '%PUBLISHED%' or ifnull(outcome,'') like '%PUBLISHED%')").fetchone()[0]
print({'healthcare':total,'scanned':scanned,'pending':pending,'hot_signal':hot,'published_signal':pub})
# sample one known
row=c.execute("select companyName, lastScannedAt, substr(ifnull(evidence,''),1,120), substr(ifnull(outcome,''),1,80) from Lead where companyName like '%Villa Dei Pini%'").fetchone()
print('pini', row)
PY
