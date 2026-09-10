#!/usr/bin/env python3
import os, sqlite3, json, hashlib
from pathlib import Path

# find Malzoni PDFs / evidence
roots = [
  Path('/opt/leadsniper-revalidate'),
  Path('/opt/leadsniper'),
]
hits = []
for root in roots:
  for p in root.rglob('*'):
    if not p.is_file():
      continue
    n = p.name.lower()
    if 'malzoni' in n or ('pars' in n and '2026' in n) or 'radiosurgery' in n:
      hits.append(str(p))
print('NAME_HITS', len(hits))
for h in hits[:60]:
  print(h)

fp = list(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers').glob('*cmqklex5g00b6108ejom1shk0*'))
print('FRONTIER', fp)
if fp:
  con = sqlite3.connect(str(fp[0]))
  rows = con.execute(
    "SELECT canonicalUrl, state, relevance, contentHash, httpStatus FROM CrawlFrontierNode "
    "WHERE lower(canonicalUrl) LIKE '%pdf%' OR lower(canonicalUrl) LIKE '%pars%' "
    "ORDER BY CASE WHEN lower(canonicalUrl) LIKE '%pars%' THEN 0 ELSE 1 END LIMIT 80"
  ).fetchall()
  for r in rows:
    print('NODE', r[0][:140], r[1], r[2], (r[3] or '')[:16], r[4])
  # evidence blobs?
  tabs = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
  print('TABLES', tabs)
  con.close()

# result evidence
rp = Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results/cmqklex5g00b6108ejom1shk0.json')
if rp.exists():
  j = json.loads(rp.read_text())
  print('STATE', j.get('processingState'), j.get('reasonCode'))
  ev = j.get('fullEvidence') or j.get('evidence') or ''
  print('EV_HAS_AUTO', 'autoassicur' in ev.lower())
  print('EV_SNIP', ev[:500])
  for k in ('policyUrl','exactUrl','sourceUrl','documentHash','pdfHash','evidenceUrl'):
    if j.get(k): print(k, j.get(k))
