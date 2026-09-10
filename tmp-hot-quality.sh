#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, glob, os, collections, re
RES='/opt/leadsniper-revalidate/data/revalidation/results'
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term={k:v for k,v in (cp.get('terminal') or {}).items() if v.get('processingState')=='HOT_VERIFIED'}
print('hot_terminal', len(term))

stats=collections.Counter()
weak=[]
for lid in term:
  p=os.path.join(RES, f'{lid}.json')
  if not os.path.isfile(p):
    stats['missing_result']+=1
    continue
  r=json.load(open(p))
  cc=r.get('crawlComplete')
  pf=r.get('policyFound')
  ps=r.get('processingState')
  dual=r.get('dualDisagreement')
  ev=r.get('fullEvidence') or ''
  idm=re.search(r'\[IDENTITY:([^\]]+)\]', ev)
  fr=re.search(r'\[FRONTIER:([^\]]+)\]', ev)
  identity=idm.group(1) if idm else '?'
  frontier=fr.group(1) if fr else '?'
  stats[f'crawlComplete={cc}']+=1
  stats[f'policyFound={pf}']+=1
  stats[f'identity={identity}']+=1
  exhausted='EXHAUSTED' in frontier
  stats[f'frontier_exhausted={exhausted}']+=1
  # weak if not complete or identity not official or policyFound true somehow
  reasons=[]
  if cc is not True: reasons.append('crawlComplete!=true')
  if pf is True: reasons.append('policyFound=true')
  if identity not in ('OFFICIAL_CONFIRMED','GROUP_OFFICIAL_CONFIRMED'): reasons.append(f'identity={identity}')
  if 'EXHAUSTED' not in frontier and 'CRAWL_COMPLETE:true' not in ev: reasons.append(f'frontier={frontier[:40]}')
  if dual: reasons.append('dualDisagreement')
  if reasons:
    weak.append({'id':lid,'company':r.get('companyName'),'reasons':reasons,'frontier':frontier[:80]})
  else:
    stats['strict_ok']+=1

print('stats', dict(stats))
print('weak_count', len(weak))
for w in weak[:15]:
  print(' WEAK', w)
PY
# dual hot env
grep -E 'DUAL_HOT|APPLY' /etc/systemd/system/giorgio-revalidate.service | head -5
