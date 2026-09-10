#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, collections, re, glob
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
reviews=[(k,v) for k,v in term.items() if v.get('processingState')=='REVIEW_HUMAN']
print('review_terminal', len(reviews))
print('retry', len(cp.get('retryQueue') or {}), 'inProgress', len(cp.get('inProgress') or {}), 'terminal_total', len(term))

reasons=collections.Counter()
samples=collections.defaultdict(list)
for lid, meta in reviews:
  rc=str(meta.get('reasonCode') or '')
  rf=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
  row_rc=''; company=''; err=''; crawl=None; identity=''; pf=None
  if os.path.isfile(rf):
    try:
      r=json.load(open(rf))
      row_rc=str(r.get('reasonCode') or r.get('error') or '')
      company=r.get('companyName') or ''
      err=str(r.get('error') or '')
      crawl=r.get('crawlComplete')
      pf=r.get('policyFound')
      ev=r.get('fullEvidence') or ''
      m=re.search(r'\[IDENTITY:([^\]]+)\]', ev)
      identity=m.group(1) if m else ''
      # also look for mismatch markers
      if 'IDENTITY_MISMATCH' in (row_rc+rc+ev).upper():
        bucket='IDENTITY_MISMATCH'
      elif 'DUAL' in (row_rc+rc).upper():
        bucket='DUAL_HOT_DISAGREE'
      elif re.search(r'DRAIN|CLIENT_ZERO_RETRY|REQUEUE', rc+row_rc, re.I):
        bucket='DRAINED_FALSE_REVIEW'
      elif re.search(r'ANALYZE|PLAYWRIGHT|TIMEOUT|LEAD_WALL', row_rc+rc+err, re.I):
        bucket='ENGINE_ERROR_DUMPED'
      elif re.search(r'RELEVANT_URL_FAILED|URL_FAILED', row_rc+rc, re.I):
        bucket='RELEVANT_URL_FAILED'
      elif re.search(r'UNREACH|DNS|ENOTFOUND|ECONNREFUSED', row_rc+rc+err+ev, re.I):
        bucket='UNREACHABLE'
      else:
        bucket='OTHER:'+ (row_rc or rc or 'REVIEW')[:60]
    except Exception as e:
      bucket='BAD_RESULT'
      company=str(e)
  else:
    bucket='NO_RESULT:'+rc[:50]
  reasons[bucket]+=1
  if len(samples[bucket])<5:
    samples[bucket].append({
      'id': lid,
      'company': company,
      'reasonCode': row_rc or rc,
      'crawlComplete': crawl,
      'policyFound': pf,
      'identity': identity,
    })

print('BY_REASON')
for k,n in reasons.most_common():
  print(f'  {n:3d}  {k}')
print('SAMPLES')
for k, arr in samples.items():
  print('---', k)
  for s in arr:
    print(' ', s)
PY
