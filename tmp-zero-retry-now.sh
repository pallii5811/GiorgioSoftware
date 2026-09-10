#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, datetime
cp_path='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
cp=json.load(open(cp_path))
rq=cp.get('retryQueue') or {}
print('RETRY_DETAIL')
for k,v in rq.items():
  print(json.dumps({'id':k, **{kk:v.get(kk) for kk in ('lastReason','lastError','attempts','nextRetryAt','strategy','parkedEngineCeiling')}}, indent=2))
# If any retry exists: terminalize to REVIEW for zero-retry client delivery
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
moved=0
for lid, meta in list(rq.items()):
  err=f"{meta.get('lastError','')} {meta.get('lastReason','')}"
  cp.setdefault('terminal',{})[lid]={
    'finishedAt': now,
    'processingState': 'REVIEW_HUMAN',
    'newVerdict': 'REVIEW',
    'reasonCode': f'CLIENT_ZERO_RETRY:{str(err)[:160]}',
    'drainedFromRetry': True,
  }
  del rq[lid]
  moved += 1
  cp.setdefault('stats',{})
  cp['stats']['review']=int(cp['stats'].get('review') or 0)+1
  cp['stats']['terminal']=len(cp.get('terminal') or {})
cp['retryQueue']=rq
cp['stats']['retry']=0
cp['updatedAt']=now
# stamp testedCodeSha to tip
cp['testedCodeSha']='e22daea1b17bb277913576f12bccf611ab5cd4f3'
json.dump(cp, open(cp_path,'w'), indent=2)
print(json.dumps({'moved':moved,'terminal':len(cp['terminal']),'retry':len(rq),'inProgress':len(cp.get('inProgress') or {})}, indent=2))
PY
