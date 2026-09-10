#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, collections
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
    weak.append({'id':lid,'reasons':['missing_result']})
    continue
  r=json.load(open(p))
  cc=r.get('crawlComplete')
  pf=r.get('policyFound')
  ev=r.get('fullEvidence') or ''
  idm=re.search(r'\[IDENTITY:([^\]]+)\]', ev)
  fr=re.search(r'\[FRONTIER:([^\]]+)\]', ev)
  identity=idm.group(1) if idm else '?'
  frontier=fr.group(1) if fr else '?'
  stats[f'crawlComplete={cc}']+=1
  stats[f'policyFound={pf}']+=1
  stats[f'identity={identity}']+=1
  stats[f'exhausted={"EXHAUSTED" in frontier}']+=1
  reasons=[]
  if cc is not True: reasons.append('crawlComplete!=true')
  if pf is True: reasons.append('policyFound=true')
  if identity not in ('OFFICIAL_CONFIRMED','GROUP_OFFICIAL_CONFIRMED'): reasons.append(f'identity={identity}')
  if 'EXHAUSTED' not in frontier: reasons.append(f'frontier={frontier[:50]}')
  if r.get('dualDisagreement'): reasons.append('dualDisagreement')
  if reasons:
    weak.append({'id':lid,'company':r.get('companyName'),'reasons':reasons})
  else:
    stats['strict_ok']+=1
print('stats', dict(stats))
print('weak_count', len(weak))
for w in weak[:10]:
  print(' WEAK', w)
print('pub_family', {
  k: sum(1 for v in (cp.get('terminal') or {}).values() if v.get('processingState')==k)
  for k in ('PUBLISHED_CURRENT','PUBLISHED_EXPIRED','PUBLISHED_DATE_UNKNOWN','SELF_INSURANCE_VERIFIED')
})
print('retry', len(cp.get('retryQueue') or {}), 'review', sum(1 for v in (cp.get('terminal') or {}).values() if v.get('processingState')=='REVIEW_HUMAN'))
PY
grep DUAL_HOT /etc/systemd/system/giorgio-revalidate.service | head -1
