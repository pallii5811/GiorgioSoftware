#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, ssl, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

RES='/opt/leadsniper-revalidate/data/revalidation/results'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
probe_small=json.load(open('/tmp/hot-small-probe.json'))
solid_ids={r['id'] for r in probe_small['solid']}
weak_done={r['id'] for r in probe_small['weak']}

cp=json.load(open(CP))
hots=[k for k,v in (cp.get('terminal') or {}).items() if v.get('processingState')=='HOT_VERIFIED']
# remaining = hot not already classified solid small (those stay) and not weak (already requeued)
remaining=[]
for lid in hots:
  if lid in weak_done: continue
  r=json.load(open(os.path.join(RES,f'{lid}.json')))
  ev=r.get('fullEvidence') or ''
  fr=re.search(r'\bn=(\d+)', ev)
  n=int(fr.group(1)) if fr else -1
  remaining.append({'id':lid,'company':r.get('companyName'),'website':r.get('website'),'n':n})

ctx=ssl.create_default_context()
ctx.check_hostname=False
ctx.verify_mode=ssl.CERT_NONE
UA={'User-Agent':'Mozilla/5.0 GiorgioAudit/1.0'}
POL=re.compile(r'polizza\s+(?:rc|assicur)|assicurazione\s+rc|amtrust|zurich|generali italia|numero\s+polizza|massimale|scheda\s+di\s+polizza', re.I)
PDF=re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.I)

def fetch(url):
  try:
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
      return r.read(600000).decode('utf-8','ignore')
  except Exception:
    return ''

def check(row):
  w=(row.get('website') or '').strip()
  if not w: return {**row,'hit':False,'why':'no_web'}
  if not w.startswith('http'): w='https://'+w
  origin='/'.join(w.split('/')[:3])
  body=''
  pdfs=0
  hits=[]
  for path in ['','/trasparenza','/amministrazione-trasparenza','/documenti']:
    url=origin+path if path else w
    b=fetch(url)
    if not b: continue
    body += '\n'+b
    pdfs += len(PDF.findall(b))
    if POL.search(b):
      hits.append(path or '/')
  strong=len(hits)>=1 and (pdfs>=2 or len(hits)>=2)
  return {**row,'website':w,'hit':strong,'paths':hits,'pdfs':pdfs,'why':('policy_signal' if strong else 'clean')}

suspect=[]
clean=[]
with ThreadPoolExecutor(max_workers=10) as ex:
  for res in as_completed([ex.submit(check,r) for r in remaining]):
    x=res.result()
    (suspect if x['hit'] else clean).append(x)

suspect.sort(key=lambda x: -(x.get('pdfs') or 0))
print(json.dumps({
  'remaining_hot_probed': len(remaining),
  'suspect_policy_signals': len(suspect),
  'clean_no_strong_signal': len(clean),
  'solid_small_kept': len(solid_ids),
}, indent=2))
print('\nSUSPECT')
for s in suspect[:40]:
  print(f"n={s['n']} pdfs={s['pdfs']} paths={s['paths']} | {s['company']}")
  print(f"  id={s['id']} {s['website']}")
json.dump({'suspect':suspect,'clean':clean}, open('/tmp/hot-large-probe.json','w'), indent=2, ensure_ascii=False)
PY
