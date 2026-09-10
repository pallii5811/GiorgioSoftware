#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import re, ssl, urllib.request, json

ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA={'User-Agent':'Mozilla/5.0'}

def fetch(url):
  req=urllib.request.Request(url, headers=UA)
  with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
    return r.read(900000).decode('utf-8','ignore'), str(r.geturl())

cases=[
  ('IATREION_HOME','http://www.iatreion.net/'),
  ('IATREION_POL','http://www.iatreion.net/polizza-responsabilita--civile.html'),
  ('GALDIERO_HOME','http://www.galdiero.it/'),
  ('GALDIERO_PRIV','http://www.galdiero.it/privacy'),
]
POL=re.compile(r'.{0,50}(?:[Pp]olizza|assicur|AmTrust|Reale Mutua|massimale|RC\s).{0,80}')
for name,url in cases:
  try:
    body, final=fetch(url)
  except Exception as e:
    print(name, 'FAIL', e); continue
  text=re.sub(r'<script[\s\S]*?</script>',' ',body, flags=re.I)
  text=re.sub(r'<style[\s\S]*?</style>',' ',text, flags=re.I)
  text=re.sub(r'<[^>]+>',' ',text)
  text=re.sub(r'\s+',' ',text)
  hits=POL.findall(text)
  print('='*60, name, 'final=', final, 'len=', len(body))
  for h in hits[:12]:
    print(' ', h.strip()[:160])
  # pdf links
  pdfs=re.findall(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', body, re.I)
  print(' pdf_links', len(pdfs), pdfs[:8])
PY
