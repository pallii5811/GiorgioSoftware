#!/usr/bin/env bash
set -euo pipefail
systemctl is-active giorgio-revalidate || true
python3 <<'PY'
import json, collections, os, re, glob, sqlite3
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
by=collections.Counter(v.get('processingState') for v in term.values())
print('checkpoint_by_state', dict(by))
print('terminal', len(term), 'retry', len(cp.get('retryQueue') or {}), 'inProgress', len(cp.get('inProgress') or {}))

# PUBLISHED_CURRENT in results
cur=[]; exp=[]; si=[]; other_pub=[]
for f in glob.glob('/opt/leadsniper-revalidate/data/revalidation/results/*.json'):
  if f.endswith('.p1.json') or f.endswith('.p2.json'): continue
  try: r=json.load(open(f))
  except: continue
  ps=r.get('processingState') or ''
  if ps=='PUBLISHED_CURRENT':
    cur.append((r.get('companyName'), r.get('policyCompany'), r.get('policyExpiry'), os.path.basename(f)))
  elif ps=='PUBLISHED_EXPIRED':
    exp.append(r.get('companyName'))
  elif ps=='SELF_INSURANCE_VERIFIED':
    si.append(r.get('companyName'))
  elif re.search(r'PUBLISHED', ps):
    other_pub.append((r.get('companyName'), ps))

print('PUBLISHED_CURRENT', len(cur))
for x in cur[:20]: print(' ', x)
print('PUBLISHED_EXPIRED', len(exp), exp)
print('SELF_INSURANCE', len(si), si)
print('OTHER_PUB', other_pub)

# how many of live V:PUB are still not rescanned
con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
live_pub=[]
for id_, ev in con.execute('SELECT id, evidence FROM Lead'):
  if re.match(r'\[V:PUB\]', ev or ''):
    live_pub.append(id_)
touched=set(term)|set(cp.get('retryQueue') or {})|set(cp.get('inProgress') or {})
inter=set(live_pub)&touched
print('live_V_PUB', len(live_pub), 'already_in_877_touch', len(inter), 'not_yet', len(set(live_pub)-touched))
# among touched published, outcomes
for lid in sorted(inter):
  t=term.get(lid)
  if t: print(' touched_pub', lid, t.get('processingState'))
  elif lid in (cp.get('retryQueue') or {}): print(' touched_pub', lid, 'RETRY', (cp['retryQueue'][lid] or {}).get('lastReason'))
  else: print(' touched_pub', lid, 'IN_PROGRESS')
PY
