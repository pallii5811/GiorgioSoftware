#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, sqlite3
NAMES = [
  'Igea', 'Federico', 'Anni Azzurri', 'Patrizia', 'De Nicola', 'Radices',
  'HERA', 'Casamia', 'CE.DI.M', 'CEDIM', 'Nexa', 'Anthea', 'FKT',
  'Grumo', 'Cedir', 'flavia', 'Heidy', 'Villa Elisa', 'Cobellis', 'Progenia',
]
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
con.row_factory=sqlite3.Row

# all REVIEW now
revs=[]
for lid, meta in term.items():
  if meta.get('processingState')!='REVIEW_HUMAN': continue
  p=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
  r=json.load(open(p)) if os.path.isfile(p) else {}
  live=con.execute('SELECT companyName, website, city FROM Lead WHERE id=?', (lid,)).fetchone()
  name=(live['companyName'] if live else r.get('companyName') or '')
  web=(live['website'] if live else r.get('website') or '')
  city=(live['city'] if live else r.get('city') or '')
  ev=r.get('fullEvidence') or ''
  rc=r.get('reasonCode') or meta.get('reasonCode')
  unresolved=r.get('unresolvedRelevantNodes')
  # parse nodi from evidence frontier
  fr=re.search(r'\[FRONTIER:([^\]]+)\]', ev)
  frontier=fr.group(1) if fr else ''
  idm=re.search(r'\[IDENTITY:([^\]]+)\]', ev)
  identity=idm.group(1) if idm else ''
  motivo=''
  m=re.search(r'(Nome struttura assente[^.\]]+|Città sul sito[^.\]]+|Città attesa[^.\]]+|omonimia[^.\]]+|DUAL[^.\]]*|RELEVANT_URL[^.\]]*)', ev, re.I)
  if m: motivo=m.group(1).strip()
  revs.append({
    'name': name, 'city': city, 'web': web, 'rc': rc, 'identity': identity,
    'unresolved': unresolved, 'frontier': frontier, 'crawlComplete': r.get('crawlComplete'),
    'motivo': motivo, 'id': lid,
  })

print('REVIEW_TOTAL', len(revs))
# print ones matching screenshot names
print('\n=== MATCH SCREENSHOT / NOMI ===')
for r in revs:
  if any(n.lower() in (r['name'] or '').lower() for n in NAMES):
    print(f"- {r['name']} | {r['city']}")
    print(f"  web: {r['web']}")
    print(f"  reasonCode={r['rc']} identity={r['identity']} crawlComplete={r['crawlComplete']} unresolved={r['unresolved']}")
    print(f"  frontier={r['frontier']}")
    print(f"  motivo={r['motivo'][:160]}")
    print()

# bucket all review
from collections import Counter
b=Counter()
for r in revs:
  if r['identity']=='MISMATCH': b['IDENTITY_MISMATCH']+=1
  elif 'DUAL' in str(r['rc']): b['DUAL']+=1
  elif r['crawlComplete'] is False and (r['unresolved'] or 0)>0: b['INCOMPLETE_NODES']+=1
  elif r['crawlComplete'] is False: b['INCOMPLETE_NO_NODES']+=1
  else: b['OTHER']+=1
print('BUCKETS', dict(b))
con.close()
PY
