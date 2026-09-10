#!/usr/bin/env bash
set -euo pipefail
# Probe mid-size HOT (20-49 nodes) with strong-policy threshold.
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
  if not (20 <= n <= 49): continue
  rows.append({'id':lid,'company':r.get('companyName'),'website':r.get('website'),'n':n,
               'policyFound':bool(r.get('policyFound')),'ev':ev[:2000]})

ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA={'User-Agent':'Mozilla/5.0 GiorgioMidAudit/1.0'}
STRONG=re.compile(
  r'polizza\s*(?:n[°o.]|numero)?\s*\d|scheda\s+di\s+polizza|polizza\s+rc|assicurazione\s+rc|'
  r'rc\s*sanitar|amtrust|zurich\s+insurance|generali\s+italia|unipol|massimale\s*(?:di|:)|'
  r'compagnia\s+di\s+assicur', re.I)
PDF=re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.I)

def fetch(url):
  try:
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
      return r.read(700000).decode('utf-8','ignore'), str(r.geturl())
  except Exception:
    return '', url

def check(row):
  w=(row.get('website') or '').strip()
  out={**row,'ok':True,'signals':[],'pdfs':0,'strong':0}
  if row.get('policyFound'):
    out['ok']=False; out['signals'].append('POLICY_FOUND_FLAG'); return out
  if not w: out['ok']=False; out['signals'].append('NO_WEB'); return out
  if not w.startswith('http'): w='https://'+w
  origin='/'.join(w.split('/')[:3])
  host=urlparse(w).netloc.lower()
  if any(x in host for x in ('facebook.com','linktr.ee','adastradigital','sorrento.it')):
    out['ok']=False; out['signals'].append('BAD_HOST'); return out
  pdfs=set(); strong=0
  for path in ['','/trasparenza','/amministrazione-trasparenza','/documenti','/privacy','/chi-siamo']:
    url=w if path=='' else origin+path
    body, final=fetch(url)
    if not body: continue
    for m in PDF.findall(body): pdfs.add(urljoin(final,m))
    sc=len(STRONG.findall(body)); strong+=sc
    if sc: out['signals'].append(f'strong:{path or "/"}')
  out['pdfs']=len(pdfs); out['strong']=strong
  if strong>=1: out['ok']=False; out['signals'].append('STRONG_POLICY')
  if len(pdfs)>=8 and strong==0:
    # soft flag only — many institutional PDF sites without insurance wording on home paths
    out['signals'].append('many_pdfs_no_strong')
  return out

results=[]
with ThreadPoolExecutor(max_workers=10) as ex:
  for fut in as_completed([ex.submit(check,r) for r in rows]):
    results.append(fut.result())
weak=[r for r in results if not r['ok']]
soft=[r for r in results if r['ok'] and 'many_pdfs_no_strong' in r['signals']]
print(json.dumps({
  'mid_hot': len(results),
  'weak_strong_signal': len(weak),
  'soft_many_pdfs': len(soft),
}, indent=2))
print('\nWEAK')
for r in weak:
  print(f"n={r['n']} strong={r['strong']} pdfs={r['pdfs']} | {r['company']}")
  print(f"  {r['signals']} id={r['id']} {r['website']}")
print('\nSOFT many pdfs (kept HOT for now)')
for r in soft[:20]:
  print(f"n={r['n']} pdfs={r['pdfs']} | {r['company']} | {r['website']}")
json.dump({'weak':weak,'soft':soft,'all':results}, open('/tmp/hot-mid-probe.json','w'), indent=2, ensure_ascii=False)
PY
