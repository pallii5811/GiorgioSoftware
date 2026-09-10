#!/bin/bash
set -euo pipefail
bash /tmp/tmp-find-pars-url.sh || true
echo '---MALZONI IT---'
curl -sL -m 30 -A 'Mozilla/5.0' 'http://www.malzoni.it/societa-trasparente/' > /tmp/malzoni-trasp.html || true
python3 - <<'PY'
import re
html=open('/tmp/malzoni-trasp.html','r',errors='ignore').read()
hrefs=re.findall(r'href=["\']([^"\']+)["\']', html, re.I)
for h in hrefs:
  if re.search(r'pars|2026|\.pdf', h, re.I):
    print(h)
# also anchor text
for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I|re.S):
  text=re.sub('<[^>]+>','',m.group(2))
  if re.search(r'PARS|Research Hospital 2026', text, re.I):
    print('ANCHOR', text.strip()[:80], '->', m.group(1))
PY
