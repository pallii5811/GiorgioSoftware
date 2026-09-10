#!/usr/bin/env bash
set -euo pipefail
# Stop briefly, requeue REVIEW that are incomplete crawls (must finish), restart.
systemctl stop giorgio-revalidate || true
sleep 2
python3 <<'PY'
import json, os, datetime, collections
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
RES='/opt/leadsniper-revalidate/data/revalidation/results'
cp=json.load(open(CP))
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
term=cp.setdefault('terminal', {})
rq=cp.setdefault('retryQueue', {})

requeued=[]
kept=[]
for lid, meta in list(term.items()):
  if meta.get('processingState')!='REVIEW_HUMAN':
    continue
  p=os.path.join(RES, f'{lid}.json')
  r={}
  if os.path.isfile(p):
    try: r=json.load(open(p))
    except Exception: pass
  rc=str(r.get('reasonCode') or meta.get('reasonCode') or '')
  cc=r.get('crawlComplete')
  ev=r.get('fullEvidence') or ''
  # Keep as REVIEW only: dual disagree, or IDENTITY_MISMATCH with crawl already complete
  # Everything incomplete MUST continue (user rule: crawl never incomplete terminal)
  incomplete = (cc is False) or ('CRAWL_COMPLETE:false' in ev) or ('FRONTIER:OPEN' in ev)
  dual = 'DUAL' in rc.upper()
  if dual and not incomplete:
    kept.append((lid, 'dual_complete', rc))
    continue
  if incomplete or rc in ('REVIEW_HUMAN',) and cc is not True:
    # requeue resume_boost forceDue
    del term[lid]
    rq[lid]={
      'attempts': 0,
      'lastReason': f'REQUEUE_INCOMPLETE_REVIEW:{rc}',
      'lastError': f'REQUEUE_INCOMPLETE_REVIEW:{rc}',
      'nextRetryAt': '1970-01-01T00:00:00.000Z',
      'forceDue': True,
      'strategy': 'resume_boost',
      'firstSeenAt': meta.get('finishedAt') or now,
      'lastAttemptAt': now,
      'operational': True,
      'requeuedIncompleteReview': True,
    }
    cp.setdefault('attempts', {})[lid]=0
    # preserve frontier path from result if any
    fps=r.get('frontierPaths') or []
    if fps: rq[lid]['frontierPath']=fps[0]
    requeued.append((lid, r.get('companyName'), rc, cc))
  else:
    kept.append((lid, 'complete_review', rc))

# recount
st=cp.setdefault('stats', {})
st['terminal']=len(term)
st['retry']=len(rq)
st['review']=sum(1 for v in term.values() if v.get('processingState')=='REVIEW_HUMAN')
st['hot']=sum(1 for v in term.values() if v.get('processingState')=='HOT_VERIFIED')
cp['updatedAt']=now
json.dump(cp, open(CP,'w'), indent=2)
print(json.dumps({
  'requeued_incomplete_reviews': len(requeued),
  'kept_review': len(kept),
  'kept_detail': kept[:15],
  'sample_requeued': [{'id':a,'name':b,'rc':c,'cc':d} for a,b,c,d in requeued[:12]],
  'terminal_now': len(term),
  'retry_now': len(rq),
  'review_left': st['review'],
}, indent=2, ensure_ascii=False))
PY

# bump wall/caps already set; ensure forceDue works
systemctl daemon-reload
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 6
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': len(cp.get('inProgress') or {}),
  'review': sum(1 for v in (cp.get('terminal') or {}).values() if v.get('processingState')=='REVIEW_HUMAN'),
}, indent=2))
PY
