#!/usr/bin/env bash
set -euo pipefail
# Strict: ANY strong policy phrase on home/trasparenza/privacy → suspect (no PDF gate).
python3 <<'PY'
import json, os, re, ssl, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

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
  rows.append({'id':lid,'company':r.get('companyName'),'website':r.get('website'),'n':n})

ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA={'User-Agent':'Mozilla/5.0 GiorgioStrictHot/1.0'}
STRONG=re.compile(
  r'polizza\s*n[°º.]?\s*\d[\d./\-]*|'
  r'numero\s+(?:di\s+)?polizza|'
  r'scheda\s+di\s+polizza|'
  r'polizza\s+rc(?:\s|/)|'
  r'assicurazione\s+rc(?:\s|/)|'
  r'rc\s*sanitar|'
  r'\bamtrust\b|'
  r'zurich\s+insurance|'
  r'generali\s+italia|'
  r'\bunipol\b|'
  r'reale\s+mutua|'
  r'massimale\s*(?:di|:|€)|'
  r'compagnia\s+di\s+assicur',
  re.I,
)

def fetch(url):
  try:
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
      return r.read(700000).decode('utf-8','ignore')
  except Exception:
    return ''

def check(row):
  w=(row.get('website') or '').strip()
  out={**row,'hit':False,'matches':[],'paths':[]}
  if not w: return out
  if not w.startswith('http'): w='https://'+w
  origin='/'.join(w.split('/')[:3])
  for path in ['','/trasparenza','/amministrazione-trasparenza','/privacy','/documenti','/chi-siamo','/note-legali']:
    url=w if path=='' else origin+path
    body=fetch(url)
    if not body: continue
    found=STRONG.findall(body)
    if found:
      out['hit']=True
      out['paths'].append(path or '/')
      # unique lower matches
      for f in found[:5]:
        if f.lower() not in [x.lower() for x in out['matches']]:
          out['matches'].append(f[:80])
  return out

suspect=[]; clean=[]
with ThreadPoolExecutor(max_workers=12) as ex:
  for fut in as_completed([ex.submit(check,r) for r in rows]):
    x=fut.result()
    (suspect if x['hit'] else clean).append(x)

suspect.sort(key=lambda x: (x['n'], x.get('company') or ''))
print(json.dumps({
  'probed': len(rows),
  'suspect_strong': len(suspect),
  'clean': len(clean),
}, indent=2))
print('\nSUSPECT (must requeue)')
for s in suspect:
  print(f"n={s['n']} paths={s['paths']} matches={s['matches'][:4]}")
  print(f"  {s['company']}")
  print(f"  id={s['id']} {s['website']}")
json.dump({'suspect':suspect,'clean':clean}, open('/tmp/hot-strict-all.json','w'), indent=2, ensure_ascii=False)
print('WROTE /tmp/hot-strict-all.json')
PY
