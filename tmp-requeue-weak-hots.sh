#!/usr/bin/env bash
set -euo pipefail
systemctl stop giorgio-revalidate || true
sleep 2
python3 <<'PY'
import json, datetime
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
probe=json.load(open('/tmp/hot-small-probe.json'))
weak=probe['weak']
cp=json.load(open(CP))
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
term=cp.setdefault('terminal',{})
rq=cp.setdefault('retryQueue',{})

# wrong-site → REVIEW (not HOT), others → deep requeue
moved_review=[]
requeued=[]
for w in weak:
  lid=w['id']
  meta=term.get(lid)
  if not meta or meta.get('processingState')!='HOT_VERIFIED':
    # maybe already moved
    continue
  del term[lid]
  if w.get('suspect_wrong_site'):
    term[lid]={
      'finishedAt': now,
      'processingState': 'REVIEW_HUMAN',
      'newVerdict': 'REVIEW',
      'reasonCode': 'AUDIT_WRONG_SITE_OR_HOST:'+ ','.join(w.get('signals') or [])[:120],
      'auditedFromHot': True,
    }
    moved_review.append(w['company'])
    continue
  # deep re-crawl
  strategy='fresh' if w['n']<=5 else 'resume_boost'
  rq[lid]={
    'attempts': 0,
    'lastReason': 'HOT_SMALL_CRAWL_AUDIT:'+ ','.join((w.get('signals') or ['n_lt_20'])[:4]),
    'lastError': 'HOT_SMALL_CRAWL_AUDIT',
    'nextRetryAt': '1970-01-01T00:00:00.000Z',
    'forceDue': True,
    'strategy': strategy,
    'firstSeenAt': meta.get('finishedAt') or now,
    'lastAttemptAt': now,
    'operational': True,
    'hotSmallCrawlAudit': True,
  }
  cp.setdefault('attempts',{})[lid]=0
  requeued.append({'company':w['company'],'n':w['n'],'strategy':strategy,'signals':w.get('signals')})

st=cp.setdefault('stats',{})
st['terminal']=len(term)
st['retry']=len(rq)
st['hot']=sum(1 for v in term.values() if v.get('processingState')=='HOT_VERIFIED')
st['review']=sum(1 for v in term.values() if v.get('processingState')=='REVIEW_HUMAN')
cp['updatedAt']=now
json.dump(cp, open(CP,'w'), indent=2)
print(json.dumps({
  'requeued_for_deep_crawl': len(requeued),
  'moved_to_review_wrong_site': moved_review,
  'hot_left': st['hot'],
  'review_now': st['review'],
  'retry_now': st['retry'],
  'requeued_sample': requeued[:15],
  'solid_small_left_as_hot': len(probe['solid']),
}, indent=2, ensure_ascii=False))
PY
systemctl daemon-reload
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 5
systemctl is-active giorgio-revalidate
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'hot': sum(1 for v in cp['terminal'].values() if v.get('processingState')=='HOT_VERIFIED'),
  'review': sum(1 for v in cp['terminal'].values() if v.get('processingState')=='REVIEW_HUMAN'),
  'retry': len(cp.get('retryQueue') or {}),
  'inProgress': len(cp.get('inProgress') or {}),
}, indent=2))
PY
