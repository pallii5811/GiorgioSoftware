#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, sqlite3
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
con.row_factory=sqlite3.Row

rows=[]
for lid, meta in term.items():
  if meta.get('processingState')!='REVIEW_HUMAN':
    continue
  p=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
  if not os.path.isfile(p):
    continue
  r=json.load(open(p))
  rc=str(r.get('reasonCode') or meta.get('reasonCode') or '')
  if 'IDENTITY_MISMATCH' not in rc.upper() and '[IDENTITY:MISMATCH]' not in (r.get('fullEvidence') or ''):
    continue
  live=con.execute('SELECT companyName, website, city, region, piva FROM Lead WHERE id=?', (lid,)).fetchone()
  ev=r.get('fullEvidence') or ''
  # extract human reason near mismatch
  reason=''
  m=re.search(r'([^.\n]{0,80}(?:omonimia|URL errato|sito errato|diversa da|non trovata sul sito|Città sul sito)[^.\n]{0,120})', ev, re.I)
  if m: reason=m.group(1).strip()
  else:
    idx=ev.upper().find('IDENTITY')
    reason=(ev[max(0,idx-120):idx+80].replace('\n',' ') if idx>=0 else rc)[:180]
  rows.append({
    'id': lid,
    'name': (live['companyName'] if live else r.get('companyName')) or '?',
    'city': (live['city'] if live else r.get('city')) or '?',
    'region': (live['region'] if live else r.get('region')) or '?',
    'website': (live['website'] if live else r.get('website')) or '?',
    'piva': (live['piva'] if live else None) or '—',
    'motivo_motore': reason or rc,
  })

con.close()
rows.sort(key=lambda x: (x['city'] or '', x['name'] or ''))
print(f'TOTALE_IDENTITY_MISMATCH={len(rows)}\n')
for i, r in enumerate(rows, 1):
  print(f"{i:2d}. {r['name']}")
  print(f"    città: {r['city']} ({r['region']})")
  print(f"    sito:  {r['website']}")
  print(f"    P.IVA: {r['piva']}")
  print(f"    motore: {r['motivo_motore']}")
  print(f"    id: {r['id']}")
  print()
# also dump json for copy
json.dump(rows, open('/tmp/identity-mismatch-all.json','w'), indent=2, ensure_ascii=False)
print('JSON=/tmp/identity-mismatch-all.json')
PY
