#!/usr/bin/env bash
set -euo pipefail
# Probe all small-crawl HOT sites for missed policy signals; requeue those not solid.
python3 <<'PY'
import json, os, re, ssl, urllib.request, urllib.error, collections, time
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor, as_completed

audit=json.load(open('/tmp/hot-small-audit.json'))
small=audit['small']

ctx=ssl.create_default_context()
# some sites have bad certs
ctx.check_hostname=False
ctx.verify_mode=ssl.CERT_NONE

UA={'User-Agent':'Mozilla/5.0 (compatible; GiorgioAudit/1.0)'}
POLICY_RE=re.compile(r'polizza|assicuraz|rc\s*sanitar|gelli|amtrust|zurich|generali|unipol|allianz|massimale|quietanza|trasparenza', re.I)
PDF_HREF=re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.I)

def fetch(url, timeout=12):
  try:
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
      raw=r.read(800_000)
      return r.getcode(), raw.decode('utf-8', errors='ignore'), str(r.geturl())
  except Exception as e:
    return None, str(e), url

def normalize_base(website):
  if not website: return None
  w=website.strip()
  if not w.startswith('http'): w='https://'+w
  # strip path to origin for probes sometimes keep path
  return w.rstrip('/')

def probe(row):
  base=normalize_base(row.get('website'))
  out={'id':row['id'],'company':row['company'],'website':base,'n':row['n'],
       'ok':False,'policy_hits':0,'pdf_links':0,'home_ok':False,'suspect_wrong_site':False,
       'signals':[],'error':None}
  if not base:
    out['error']='no_website'; return out
  # wrong-site heuristics
  host=re.sub(r'^https?://(www\.)?','',base.lower())
  host=host.split('/')[0]
  if any(x in host for x in ('sorrento.it','adastradigital','linktr.ee','facebook.com','turismo')):
    out['suspect_wrong_site']=True
    out['signals'].append(f'suspicious_host:{host}')

  paths=['', '/trasparenza', '/amministrazione-trasparenza', '/privacy',
         '/documenti', '/chi-siamo', '/assicurazione', '/polizza']
  texts=[]
  pdfs=set()
  home_ok=False
  for path in paths:
    url=base if path=='' else (base.split('/')[0]+'//'+base.split('//',1)[1].split('/')[0]+path if '//' in base else base+path)
    # simpler
    if path=='':
      url=base
    else:
      origin='/'.join(base.split('/')[:3])
      url=origin+path
    code, body, final=fetch(url)
    if code and 200<=code<400 and isinstance(body,str) and len(body)>200:
      if path=='': home_ok=True
      texts.append(body)
      for m in PDF_HREF.finditer(body):
        pdfs.add(m.group(1))
      if POLICY_RE.search(body):
        out['policy_hits']+=len(POLICY_RE.findall(body))
        out['signals'].append(f'policy_kw_on:{path or "/"}')
  out['home_ok']=home_ok
  out['pdf_links']=len(pdfs)
  # if many pdf links but crawl had 0 pdfs read - missed
  if out['pdf_links']>=3 and (row.get('pdf_tot') in (0,None)):
    out['signals'].append(f'missed_pdfs_on_homeish:{out["pdf_links"]}')
  # if policy keywords and HOT - needs recheck
  if out['policy_hits']>=2:
    out['signals'].append('policy_keywords_present')
  # tiny crawl but site has many pdfs or policy kw -> not solid
  out['ok']= home_ok and not out['suspect_wrong_site'] and out['policy_hits']<2 and out['pdf_links']<3 and row['n']>=8
  # n<=5 always requeue for deep
  if row['n']<=5:
    out['ok']=False
    out['signals'].append('force_requeue_n_le_5')
  if out['suspect_wrong_site']:
    out['ok']=False
  if 'policy_keywords_present' in out['signals'] or any(s.startswith('missed_pdfs') for s in out['signals']):
    out['ok']=False
  return out

results=[]
with ThreadPoolExecutor(max_workers=8) as ex:
  futs={ex.submit(probe,r): r for r in small}
  for fut in as_completed(futs):
    results.append(fut.result())

results.sort(key=lambda x: (x['ok'], x['n'], x['company'] or ''))
solid=[r for r in results if r['ok']]
weak=[r for r in results if not r['ok']]
print(json.dumps({
  'probed': len(results),
  'solid_enough': len(solid),
  'needs_requeue': len(weak),
}, indent=2))
print('\n=== NEEDS REQUEUE ===')
for r in weak:
  print(f"n={r['n']} hits={r['policy_hits']} pdfs={r['pdf_links']} home={r['home_ok']} wrong={r['suspect_wrong_site']} | {r['company']}")
  print(f"  signals={r['signals'][:6]}")
  print(f"  id={r['id']} web={r['website']}")
print('\n=== SOLID (n>=8, no policy kw burst, few pdfs) ===')
for r in solid:
  print(f"n={r['n']} | {r['company']} | {r['website']}")

json.dump({'solid':solid,'weak':weak}, open('/tmp/hot-small-probe.json','w'), indent=2, ensure_ascii=False)
print('WROTE /tmp/hot-small-probe.json')
PY
