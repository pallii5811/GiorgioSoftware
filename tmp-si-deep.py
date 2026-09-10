#!/usr/bin/env python3
import sqlite3, subprocess, hashlib
from pathlib import Path

fp = Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite')
con = sqlite3.connect(str(fp))
rows = con.execute(
    "SELECT canonicalUrl, substr(normalizedText,1,300), substr(policyText,1,300), policyFound, ocrStatus, contentHash "
    "FROM CrawlNodeEvidence WHERE lower(normalizedText) LIKE '%autoassic%' OR lower(policyText) LIKE '%autoassic%' "
    "OR lower(normalizedText) LIKE '%regime di auto%' OR lower(policyText) LIKE '%pars%' LIMIT 30"
).fetchall()
print('SI_EVIDENCE_ROWS', len(rows))
for r in rows:
    print('URL', r[0])
    print('NT', r[1])
    print('PT', r[2])
    print('pf', r[3], 'ocr', r[4], 'hash', r[5])
    print('---')

# any PARS-like
for r in con.execute(
    "SELECT canonicalUrl, length(normalizedText), policyFound FROM CrawlNodeEvidence "
    "WHERE lower(canonicalUrl) LIKE '%pars%' OR lower(normalizedText) LIKE '%posizione assicurativa%' LIMIT 20"
):
    print('PARSISH', r)
con.close()

# fetch candidate URLs
urls = [
  'https://malzonicenter.com/trasparenza/',
  'https://www.malzoni.it/',
  'https://www.radiosurgerymalzoni.it/it/societa-trasparente',
]
for u in urls:
    try:
        out = subprocess.check_output(['curl','-sL','-m','25',u], text=True, errors='ignore')
    except Exception as e:
        print('fetch_fail', u, e); continue
    import re
    hrefs = re.findall(r'href=["\']([^"\']+)["\']', out, re.I)
    for h in hrefs:
        if re.search(r'pars|autoassic|polizz|assicur', h, re.I):
            print('HREF', u, '->', h)
