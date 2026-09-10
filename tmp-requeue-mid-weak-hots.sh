#!/usr/bin/env bash
set -euo pipefail
# Show what matched on the 2 mid weak HOT, then demote them (+ optional many-pdf soft) to deep retry.
python3 <<'PY'
import json, re, ssl, urllib.request

ids = {
  'cmqma6d8e000q9g5crb0tkxag': 'http://www.iatreion.net/',
  'cmqmctogz008i9g5ctaoy1ii1': 'http://www.galdiero.it/',
}
STRONG=re.compile(
  r'polizza\s*(?:n[°o.]|numero)?\s*\d|scheda\s+di\s+polizza|polizza\s+rc|assicurazione\s+rc|'
  r'rc\s*sanitar|amtrust|zurich\s+insurance|generali\s+italia|unipol|massimale\s*(?:di|:)|'
  r'compagnia\s+di\s+assicur', re.I)
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA={'User-Agent':'Mozilla/5.0'}

for lid, url in ids.items():
  try:
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
      body=r.read(500000).decode('utf-8','ignore')
  except Exception as e:
    print(lid, 'FETCH_FAIL', e); continue
  for m in STRONG.finditer(body):
    start=max(0,m.start()-80); end=min(len(body), m.end()+80)
    snip=re.sub(r'\s+',' ', body[start:end])
    print(f'=== {lid} match={m.group(0)!r}')
    print(' ', snip[:240])
PY

systemctl stop giorgio-revalidate || true
sleep 2

python3 <<'PY'
import json, datetime
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
cp=json.load(open(CP))
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
term=cp.setdefault('terminal',{})
rq=cp.setdefault('retryQueue',{})

# strong policy homepage signals from mid probe
to_requeue = [
  ('cmqma6d8e000q9g5crb0tkxag', 'HOT_MID_AUDIT:STRONG_POLICY_HOME'),
  ('cmqmctogz008i9g5ctaoy1ii1', 'HOT_MID_AUDIT:STRONG_POLICY_HOME_PRIVACY'),
  # many PDFs on site, crawl may have under-read — deepen
  ('cmqn356yd000nzcq97g299ps1', 'HOT_MID_AUDIT:MANY_PDFS_25'),
]
moved=[]
for lid, reason in to_requeue:
  meta=term.get(lid)
  if not meta or meta.get('processingState')!='HOT_VERIFIED':
    print('skip', lid, meta)
    continue
  del term[lid]
  rq[lid]={
    'attempts': 0,
    'lastReason': reason,
    'lastError': reason,
    'nextRetryAt': '1970-01-01T00:00:00.000Z',
    'forceDue': True,
    'strategy': 'resume_boost',
    'firstSeenAt': meta.get('finishedAt') or now,
    'lastAttemptAt': now,
    'operational': True,
    'hotMidAudit': True,
  }
  cp.setdefault('attempts',{})[lid]=0
  moved.append(lid)

st=cp.setdefault('stats',{})
st['terminal']=len(term)
st['retry']=len(rq)
st['hot']=sum(1 for v in term.values() if v.get('processingState')=='HOT_VERIFIED')
st['review']=sum(1 for v in term.values() if v.get('processingState')=='REVIEW_HUMAN')
cp['updatedAt']=now
json.dump(cp, open(CP,'w'), indent=2)
print(json.dumps({
  'requeued': moved,
  'hot_now': st['hot'],
  'retry_now': st['retry'],
  'review_now': st['review'],
}, indent=2))
PY

systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 4
systemctl is-active giorgio-revalidate
