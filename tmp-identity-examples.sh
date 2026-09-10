#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, sqlite3
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
reviews=[(k,v) for k,v in (cp.get('terminal') or {}).items() if v.get('processingState')=='REVIEW_HUMAN']
# pick 5 IDENTITY_MISMATCH with full evidence snippets
n=0
for lid, meta in reviews:
  p=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
  if not os.path.isfile(p):
    continue
  r=json.load(open(p))
  if str(r.get('reasonCode') or '') != 'IDENTITY_MISMATCH':
    continue
  ev=r.get('fullEvidence') or ''
  # live lead fields
  con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
  con.row_factory=sqlite3.Row
  live=con.execute('SELECT companyName, website, city, piva, phone FROM Lead WHERE id=?', (lid,)).fetchone()
  con.close()
  print('='*70)
  print('ID', lid)
  print('LEAD', dict(live) if live else None)
  print('SHADOW company', r.get('companyName'), 'city', r.get('city'), 'website', r.get('website'))
  print('identity markers:')
  for m in re.finditer(r'\[IDENTITY[^\]]*\]|IDENTITY[^\n]{0,120}|mismatch[^\n]{0,120}|P\.?\s*IVA[^\n]{0,80}|hostname[^\n]{0,80}', ev, re.I):
    print(' ', m.group(0)[:200])
  # tail with identity context
  idx=ev.upper().find('IDENTITY')
  if idx>=0:
    print('EV_CTX:', ev[max(0,idx-200):idx+400])
  print('crawlComplete', r.get('crawlComplete'), 'policyFound', r.get('policyFound'))
  n+=1
  if n>=5: break
print('shown', n)
PY
