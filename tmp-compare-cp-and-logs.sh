#!/usr/bin/env bash
# READ-ONLY: compare pre-fix CP vs now + sample app log
set -uo pipefail
echo "======== COMPARE CHECKPOINTS ========"
python3 <<'PY'
import json
from collections import Counter
from pathlib import Path

def snap(path):
    cp=json.loads(Path(path).read_text())
    term=cp.get('terminal') or {}
    rq=cp.get('retryQueue') or {}
    st=Counter(v.get('processingState') for v in term.values())
    return {
        'file': Path(path).name,
        'updatedAt': cp.get('updatedAt'),
        'stats': cp.get('stats'),
        'terminal': len(term),
        'states': dict(st.most_common()),
        'retry': len(rq),
        'inProgress': len(cp.get('inProgress') or {}),
        'pub': sum(v for k,v in st.items() if str(k).startswith('PUBLISHED')),
        'hot': st.get('HOT_VERIFIED',0),
        'review': st.get('REVIEW_HUMAN',0),
    }

paths=[
 '/opt/leadsniper-revalidate/data/revalidation/checkpoint.pre-dynamic-url-fix-20260728T1011Z.json',
 '/opt/leadsniper-revalidate/data/revalidation/checkpoint.json.before-bounded-retry-1785186781,81943.bak',
 '/opt/leadsniper-revalidate/data/revalidation/checkpoint.json',
]
for p in paths:
    try:
        print(json.dumps(snap(p), indent=2, ensure_ascii=False))
    except Exception as e:
        print(p, e)
    print('---')

# terminal finish rate last hours from CURRENT
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
from datetime import datetime, timezone, timedelta
now=datetime.now(timezone.utc)
bins=Counter()
for v in (cp.get('terminal') or {}).values():
    fa=v.get('finishedAt')
    if not fa: continue
    try:
        dt=datetime.fromisoformat(fa.replace('Z','+00:00'))
    except: continue
    hours=int((now-dt).total_seconds()//3600)
    bins[f'{hours}h_ago']+=1
print('terminal_age_hours', dict(sorted(bins.items(), key=lambda x:int(x[0].split('h')[0]))))
PY

echo
echo "======== APP LOG TAIL (last 80 non-empty) ========"
tail -n 200 /opt/leadsniper-revalidate/logs/systemd-revalidate.log | grep -v '^$' | tail -80

echo
echo "======== APP LOG COUNTS TODAY ========"
# count event types if JSON lines
python3 <<'PY'
from collections import Counter
from pathlib import Path
import json, re
p=Path('/opt/leadsniper-revalidate/logs/systemd-revalidate.log')
# only last ~2MB
data=p.read_bytes()[-2_000_000:].decode('utf-8','ignore')
lines=data.splitlines()
ev=Counter(); reasons=Counter(); n=0
for line in lines:
    line=line.strip()
    if not line.startswith('{'): continue
    try:
        o=json.loads(line)
    except: continue
    n+=1
    e=o.get('event') or o.get('type') or 'json'
    ev[e]+=1
    for k in ('lastReason','reason','reasonCode','error','errorClass'):
        if o.get(k): reasons[str(o[k])[:60]]+=1
print('json_lines_in_tail2MB', n)
print('events_top', dict(ev.most_common(25)))
print('reasonish_top', dict(reasons.most_common(20)))
# look for EXHAUSTIVE / RENDER / comuni keywords
for kw in ('EXHAUSTIVE','RENDER_EVERY','RECERTIFICATION','IDENTITY','comuni','CRAWL_HTML_URL_CAP=0','oom','LEAD_WALL'):
    print(kw, data.lower().count(kw.lower()))
PY

echo
echo "======== DROP-INS EFFECTIVE ENV ========"
systemctl show giorgio-revalidate -p Environment | tr ' ' '\n' | grep -E 'TOTAL_WORKERS|CONCURRENCY|CRAWL_HTML|EXHAUSTIVE|RENDER|MAX_SLICES|CAP'
echo
echo "======== comuni.json size ========"
wc -c /opt/leadsniper-revalidate/app/data/comuni.json 2>/dev/null
ls -la --time-style=long-iso /opt/leadsniper-revalidate/app/data/comuni.json /opt/leadsniper-revalidate/app/src/lib/sanita/region-cities.ts 2>/dev/null
