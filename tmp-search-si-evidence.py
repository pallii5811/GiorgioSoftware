#!/usr/bin/env python3
import sqlite3
from pathlib import Path
fp = Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite')
con = sqlite3.connect(str(fp))
cols = con.execute('PRAGMA table_info(CrawlNodeEvidence)').fetchall()
print('ev_cols', cols)
# search text for autoassicur
try:
  rows = con.execute(
    "SELECT nodeId, substr(cast(excerpt as text),1,200) FROM CrawlNodeEvidence WHERE cast(excerpt as text) LIKE '%autoassic%' OR cast(text as text) LIKE '%autoassic%' LIMIT 20"
  ).fetchall()
  print('hits', len(rows), rows[:5])
except Exception as e:
  print('qerr', e)
  # list columns content
  sample = con.execute('SELECT * FROM CrawlNodeEvidence LIMIT 1').fetchone()
  print('sample', sample[:5] if sample else None)
# also search any url with pars/malzoni research
for r in con.execute("SELECT canonicalUrl FROM CrawlFrontierNode WHERE lower(canonicalUrl) LIKE '%pars%' OR lower(canonicalUrl) LIKE '%malzoni%research%' OR lower(canonicalUrl) LIKE '%malzonicenter%'"):
  print('URL', r[0])
con.close()
