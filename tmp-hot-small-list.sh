#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, collections, sqlite3
RES='/opt/leadsniper-revalidate/data/revalidation/results'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
cp=json.load(open(CP))
hots=[k for k,v in (cp.get('terminal') or {}).items() if v.get('processingState')=='HOT_VERIFIED']

rows=[]
for lid in hots:
  r=json.load(open(os.path.join(RES, f'{lid}.json')))
  ev=r.get('fullEvidence') or ''
  fr=re.search(r'\[FRONTIER:([^\]]+)\]', ev)
  frontier=fr.group(1) if fr else ''
  nm=re.search(r'\bn=(\d+)', frontier)
  n=int(nm.group(1)) if nm else -1
  pdf_m=re.search(r'PDF polizza letti (\d+)/(\d+)', ev)
  pdf_read=int(pdf_m.group(1)) if pdf_m else None
  pdf_tot=int(pdf_m.group(2)) if pdf_m else None
  # pages mentioned
  pages_m=re.search(r'sito web \((\d+) pagine', ev)
  pages=int(pages_m.group(1)) if pages_m else None
  trasparenza='Trasparenza' in ev or 'trasparenza' in ev.lower()
  rows.append({
    'id': lid,
    'company': r.get('companyName'),
    'website': r.get('website'),
    'n': n,
    'pages': pages,
    'pdf_read': pdf_read,
    'pdf_tot': pdf_tot,
    'trasparenza': trasparenza,
    'crawlComplete': r.get('crawlComplete'),
    'frontier': frontier,
    'fps': (r.get('frontierPaths') or [None])[0],
  })

rows.sort(key=lambda x: (x['n'] if x['n']>=0 else 999, x['company'] or ''))
small=[r for r in rows if 0<=r['n']<20]
print('HOT_TOTAL', len(rows))
print('SMALL_n_lt_20', len(small))
print('\n=== ALL SMALL CRAWL HOT (n<20) ===')
for i,r in enumerate(small,1):
  print(f"{i:2d}. n={r['n']:3d} pages={r['pages']} pdf={r['pdf_read']}/{r['pdf_tot']} trasp={r['trasparenza']} | {r['company']}")
  print(f"    web={r['website']}")
  print(f"    id={r['id']}")
  print(f"    frontier={r['frontier']}")

# classify risk
# HIGH: n<=5 OR pages very low with no pdf
# MED: n<20
high=[r for r in small if r['n']<=5]
print('\nHIGH_RISK_n_le_5', len(high))
json.dump({'small':small,'high':high,'all_hot_count':len(rows)}, open('/tmp/hot-small-audit.json','w'), indent=2, ensure_ascii=False)
print('WROTE /tmp/hot-small-audit.json')
PY
