#!/usr/bin/env bash
set -euo pipefail
echo '=== find baseline 117 ==='
find /opt/leadsniper /opt/leadsniper-revalidate -iname '*published*legacy*' 2>/dev/null | head -40
find /opt/leadsniper /opt/leadsniper-revalidate -iname '*baseline*117*' 2>/dev/null | head -20
ls -la /opt/leadsniper/backups 2>/dev/null | head -30 || echo 'no backups dir'
ls -la /opt/leadsniper-revalidate/data/k3-stopship/backups 2>/dev/null | head -20 || true
# try sqlite count of published on live
python3 <<'PY'
import sqlite3, re
db='/opt/leadsniper/prisma/dev.db'
con=sqlite3.connect(f'file:{db}?mode=ro', uri=True)
rows=con.execute("SELECT id, companyName, evidence FROM Lead").fetchall()
pub=[]
for i,n,e in rows:
  e=e or ''
  if re.search(r'\[V:PUBLISHED\]|PUBLISHED_|SELF_INSURANCE', e, re.I):
    pub.append(i)
print('live_pub_family_count', len(pub))
print('live_total_leads', len(rows))
PY
