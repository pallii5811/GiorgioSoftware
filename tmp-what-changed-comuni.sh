#!/usr/bin/env bash
# READ-ONLY: what changed around comuni / dynamic-url fix vs now
set -uo pipefail

echo "======== 1. DROP-IN FILES (mtime + content keywords) ========"
ls -lat --time-style=long-iso /etc/systemd/system/giorgio-revalidate.service.d/ 2>/dev/null
echo
for f in /etc/systemd/system/giorgio-revalidate.service /etc/systemd/system/giorgio-revalidate.service.d/*.conf; do
  echo "---- $f ----"
  ls -la --time-style=long-iso "$f"
  grep -E 'CRAWL_|CONCURRENCY|WORKERS|EXHAUSTIVE|RENDER|SLICE|SITEMAP|COMUN|REGION' "$f" 2>/dev/null || true
done

echo
echo "======== 2. EFFECTIVE ENV NOW ========"
systemctl show giorgio-revalidate -p Environment | tr ' ' '\n' | grep -E 'CRAWL_|CONCURRENCY|WORKERS|EXHAUSTIVE|RENDER|SLICE|SITEMAP|HTML_URL' | sort

echo
echo "======== 3. CODE / DATA mtimes around comuni ========"
ls -lat --time-style=long-iso \
  /opt/leadsniper-revalidate/app/data/comuni.json \
  /opt/leadsniper-revalidate/app/src/lib/sanita/region*.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/discover-region.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/regional*.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/site-identity.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/entity-fingerprint.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/crawl-slice-runner.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/frontier-store.ts \
  /opt/leadsniper-revalidate/app/src/lib/sanita/lead-completion.ts \
  /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-v3.mjs \
  /opt/leadsniper-revalidate/app/RELEASE_SHA \
  2>/dev/null | head -40

echo
echo "======== 4. RELEASE SHA + recent deploy markers ========"
cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null
ls -lat --time-style=long-iso /opt/leadsniper-revalidate/app/*.md /opt/leadsniper-revalidate/data/*HANDOFF* /opt/leadsniper-revalidate/data/*GPT* 2>/dev/null | head -20
# find dropins or notes from today
find /opt/leadsniper-revalidate -maxdepth 3 -type f \( -iname '*comuni*' -o -iname '*dynamic*' -o -iname '*url-fix*' -o -iname '*gpt*' \) 2>/dev/null | head -40

echo
echo "======== 5. COMPARE CP before dynamic-url-fix vs NOW (throughput) ========"
python3 <<'PY'
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

def load(p):
    return json.loads(Path(p).read_text())

pre=load('/opt/leadsniper-revalidate/data/revalidation/checkpoint.pre-dynamic-url-fix-20260728T1011Z.json')
now=load('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')

def term_hours(cp):
    c=Counter()
    for v in (cp.get('terminal') or {}).values():
        fa=v.get('finishedAt')
        if not fa: continue
        dt=datetime.fromisoformat(fa.replace('Z','+00:00'))
        c[dt.strftime('%Y-%m-%d %H')]+=1
    return dict(sorted(c.items()))

print('PRE updatedAt', pre.get('updatedAt'))
print('PRE stats', pre.get('stats'))
print('PRE terminal', len(pre.get('terminal') or {}), 'retry', len(pre.get('retryQueue') or {}))
print('NOW updatedAt', now.get('updatedAt'))
print('NOW stats', now.get('stats'))
print('NOW terminal', len(now.get('terminal') or {}), 'retry', len(now.get('retryQueue') or {}))
print('PRE hours', term_hours(pre))
print('NOW hours', term_hours(now))

# reasons now vs if pre had reasons
def fam(cp):
    c=Counter()
    for v in (cp.get('retryQueue') or {}).values():
        b=f"{v.get('lastReason')} {v.get('lastError')}".upper()
        if 'IDENTITY' in b: c['IDENTITY']+=1
        elif 'FRONTIER' in b or 'INCOMPLETE' in b: c['INCOMPLETE']+=1
        elif 'RECERT' in b: c['RECERT']+=1
        elif 'RETRY_PENDING' in b: c['RETRY_PENDING']+=1
        elif 'PDF' in b: c['PDF']+=1
        elif 'REVIEW' in b: c['REVIEW']+=1
        else: c['OTHER']+=1
    return dict(c.most_common())
print('PRE retry families', fam(pre))
print('NOW retry families', fam(now))
PY

echo
echo "======== 6. Grep code for MAX_SLICES / RENDER_EVERY / REQUIRE_EXHAUSTIVE ========"
grep -Rsn --include='*.mjs' --include='*.ts' --include='*.conf' \
  'CRAWL_MAX_SLICES_PER_LEAD\|CRAWL_RENDER_EVERY_HTML\|CRAWL_REQUIRE_EXHAUSTIVE\|CRAWL_HTML_URL_CAP' \
  /opt/leadsniper-revalidate/app/scripts /opt/leadsniper-revalidate/app/src/lib/sanita \
  /etc/systemd/system/giorgio-revalidate.service.d 2>/dev/null | head -60

echo
echo "======== 7. Which drop-in sets the slow flags? ========"
grep -Rsn 'CRAWL_MAX_SLICES\|RENDER_EVERY\|REQUIRE_EXHAUSTIVE\|HTML_URL_CAP=0\|SITEMAP_URL_CAP' \
  /etc/systemd/system/giorgio-revalidate.service* 2>/dev/null

echo
echo "======== 8. Log around 18:41 last terminal then stall ========"
# find lines with terminal 36->37 or PUBLISHED after 18:40
python3 <<'PY'
from pathlib import Path
import json
p=Path('/opt/leadsniper-revalidate/logs/systemd-revalidate.log')
# scan last 8MB
data=p.read_bytes()[-8_000_000:].decode('utf-8','ignore').splitlines()
interesting=[]
for line in data:
    if '"event":"lead_done"' not in line: continue
    try:o=json.loads(line.strip())
    except: continue
    st=o.get('processingState')
    if st and st!='RETRY_PENDING' and o.get('kind')=='terminal':
        interesting.append(o)
print('terminal_lead_done_in_tail', len(interesting))
for o in interesting[-8:]:
    print(o)
# count RETRY vs terminal after last pub id
last_id='cmqpqt2y000j7109jlv5pkvde'
seen=False
retry_after=0
term_after=0
for line in data:
    if last_id in line and 'lead_done' in line:
        seen=True
    if not seen: continue
    if '"event":"lead_done"' not in line: continue
    try:o=json.loads(line.strip())
    except: continue
    if o.get('processingState')=='RETRY_PENDING': retry_after+=1
    elif o.get('kind')=='terminal': term_after+=1
print('after_last_terminal: retry_lead_done', retry_after, 'terminal_lead_done', term_after)
PY
