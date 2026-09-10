#!/usr/bin/env bash
set -euo pipefail
# Deep-check remaining small HOT (n<20): evidence gates + deeper site probe.
python3 <<'PY'
import json, os, re, ssl, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlparse

CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
RES='/opt/leadsniper-revalidate/data/revalidation/results'
cp=json.load(open(CP))
hots=[k for k,v in (cp.get('terminal') or {}).items() if v.get('processingState')=='HOT_VERIFIED']

rows=[]
for lid in hots:
  r=json.load(open(os.path.join(RES,f'{lid}.json')))
  ev=r.get('fullEvidence') or ''
  m=re.search(r'\bn=(\d+)', ev)
  n=int(m.group(1)) if m else -1
  if n<0 or n>=20: continue
  rows.append({
    'id': lid,
    'company': r.get('companyName'),
    'website': r.get('website'),
    'n': n,
    'ev': ev,
    'crawlComplete': bool(r.get('crawlComplete')),
    'policyFound': bool(r.get('policyFound')),
    'officialConfirmed': r.get('officialConfirmed'),
    'reasonCode': (cp['terminal'].get(lid) or {}).get('reasonCode'),
    'processingNotes': r.get('processingNotes') or r.get('notes'),
    'frontierOpen': 'FRONTIER:OPEN' in ev or 'FRONTIER_OPEN' in ev,
    'exhausted': 'EXHAUSTED' in ev or 'frontierExhausted' in ev.lower() if isinstance(ev,str) else False,
  })

# evidence keyword scan
POL_EV=re.compile(r'polizza|assicuraz|amtrust|zurich|generali|unipol|allianz|massimale|rc\s*sanitar|gelli|parm|self.?insur', re.I)

ctx=ssl.create_default_context()
ctx.check_hostname=False
ctx.verify_mode=ssl.CERT_NONE
UA={'User-Agent':'Mozilla/5.0 GiorgioDeepAudit/1.0'}
STRONG=re.compile(
  r'polizza\s*(?:n[°o.]|numero)?\s*\d|scheda\s+di\s+polizza|polizza\s+rc|assicurazione\s+rc|'
  r'rc\s*sanitar|amtrust|zurich\s+insurance|generali\s+italia|unipol|massimale\s*(?:di|:)|'
  r'compagnia\s+di\s+assicur',
  re.I,
)
SOFT=re.compile(r'polizza|assicuraz|trasparenza|gelli|parm|rc\s*med', re.I)
PDF=re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.I)

def fetch(url, timeout=12):
  try:
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
      return r.getcode(), r.read(900000).decode('utf-8','ignore'), str(r.geturl())
  except Exception as e:
    return None, str(e), url

def deep(row):
  w=(row.get('website') or '').strip()
  out={**row, 'ok':True, 'signals':[], 'pdfs':0, 'strong':0, 'soft':0, 'home_ok':False}
  # evidence internal contradiction
  if row.get('policyFound'):
    out['ok']=False; out['signals'].append('RESULT_POLICY_FOUND_BUT_HOT')
  if POL_EV.search(row.get('ev') or ''):
    # allow words like "nessuna polizza" etc — still flag for review
    out['signals'].append('EVIDENCE_HAS_POLICY_WORDS')
  if row.get('frontierOpen'):
    out['ok']=False; out['signals'].append('FRONTIER_OPEN')
  if not row.get('crawlComplete') and row.get('crawlComplete') is False:
    out['ok']=False; out['signals'].append('CRAWL_INCOMPLETE')
  if not w:
    out['ok']=False; out['signals'].append('NO_WEBSITE'); return out
  if not w.startswith('http'): w='https://'+w
  origin='/'.join(w.split('/')[:3])
  host=urlparse(w).netloc.lower().replace('www.','')
  if any(x in host for x in ('facebook.com','linktr.ee','tripadvisor','booking.com','pagesjaunes','paginegialle')):
    out['ok']=False; out['signals'].append('BAD_HOST:'+host)

  paths=['','/trasparenza','/amministrazione-trasparente','/amministrazione-trasparenza',
         '/documenti','/documentazione','/privacy','/note-legali','/chi-siamo','/la-struttura',
         '/assicurazione','/polizza','/wp-content/uploads/','/sitemap.xml','/robots.txt']
  pdfs=set(); strong=0; soft=0; home_ok=False; bodies=0
  for path in paths:
    url = w if path=='' else origin+path
    code, body, final = fetch(url)
    if not code or not isinstance(body,str) or len(body)<80: continue
    bodies += 1
    if path=='': home_ok=True
    for m in PDF.findall(body):
      pdfs.add(urljoin(final, m))
    sc=len(STRONG.findall(body))
    so=len(SOFT.findall(body))
    strong += sc; soft += so
    if sc:
      out['signals'].append(f'strong_on:{path or "/"}:{sc}')
    if path=='/sitemap.xml' and '.pdf' in body.lower():
      out['signals'].append('sitemap_lists_pdf')
  out['home_ok']=home_ok
  out['pdfs']=len(pdfs)
  out['strong']=strong
  out['soft']=soft
  out['pages_ok']=bodies
  # decision: fail if strong policy signal OR many pdfs with soft insurance words
  if strong>=1:
    out['ok']=False; out['signals'].append('STRONG_POLICY_SIGNAL')
  if out['pdfs']>=4 and soft>=3:
    out['ok']=False; out['signals'].append('MANY_PDFS_PLUS_INSURANCE_WORDS')
  if not home_ok:
    out['ok']=False; out['signals'].append('HOME_UNREACHABLE')
  # n==8 with almost no pages crawled relative to site richness
  if row['n']<=10 and out['pdfs']>=5:
    out['ok']=False; out['signals'].append('TINY_CRAWL_MANY_PDFS')
  return out

results=[]
with ThreadPoolExecutor(max_workers=8) as ex:
  for fut in as_completed([ex.submit(deep,r) for r in rows]):
    results.append(fut.result())

results.sort(key=lambda x: (x['ok'], x['n'], x.get('company') or ''))
solid=[r for r in results if r['ok']]
weak=[r for r in results if not r['ok']]
print(json.dumps({
  'small_hot_checked': len(results),
  'still_solid': len(solid),
  'needs_requeue_or_review': len(weak),
}, indent=2))
print('\n=== WEAK / NOT 100% ===')
for r in weak:
  print(f"n={r['n']} strong={r['strong']} soft={r['soft']} pdfs={r['pdfs']} home={r['home_ok']} | {r['company']}")
  print(f"  signals={r['signals'][:8]}")
  print(f"  id={r['id']} {r['website']}")
print('\n=== SOLID ENOUGH ===')
for r in solid:
  print(f"n={r['n']} soft={r['soft']} pdfs={r['pdfs']} | {r['company']} | {r['website']}")

json.dump({'solid':solid,'weak':weak}, open('/tmp/hot-small-deep.json','w'), indent=2, ensure_ascii=False)
print('WROTE /tmp/hot-small-deep.json')
PY
