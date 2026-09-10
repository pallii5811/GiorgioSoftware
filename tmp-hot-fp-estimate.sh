#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import json, os, re, sqlite3, collections, csv
RES='/opt/leadsniper-revalidate/data/revalidation/results'
CP='/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'
CSV='/opt/leadsniper-revalidate/app/docs/human-review/published-baseline-final/published-baseline.csv'
cp=json.load(open(CP))
hots=[k for k,v in (cp.get('terminal') or {}).items() if v.get('processingState')=='HOT_VERIFIED']

# baseline published ids
pub=set()
if os.path.isfile(CSV):
  for row in csv.DictReader(open(CSV, encoding='utf-8', errors='replace')):
    if (row.get('verdict_storico') or '').upper()=='PUBLISHED' and row.get('leadId'):
      pub.add(row['leadId'])

con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
live_pub=set()
for id_, ev in con.execute('SELECT id, evidence FROM Lead'):
  if re.match(r'\[V:PUB\]', ev or ''):
    live_pub.add(id_)

suspect=[]
buckets=collections.Counter()
for lid in hots:
  r=json.load(open(os.path.join(RES, f'{lid}.json')))
  ev=r.get('fullEvidence') or ''
  fr=re.search(r'\[FRONTIER:([^\]]+)\]', ev)
  frontier=fr.group(1) if fr else ''
  # n= nodes visited
  nm=re.search(r'n=(\d+)', frontier)
  n=int(nm.group(1)) if nm else -1
  pdfm=re.search(r'PDF polizza letti (\d+)/(\d+)', ev) or re.search(r'pdf=(\d+)', frontier)
  flags=[]
  if lid in live_pub or lid in pub:
    flags.append('WAS_LEGACY_PUB')
  if n>=0 and n < 20:
    flags.append(f'SMALL_CRAWL_n={n}')
  if re.search(r'OCR|scansionat|immagine', ev, re.I) and re.search(r'pdf=0|PDF polizza letti 0/', ev):
    flags.append('NO_PDF_READ')
  # pdfs read low relative
  mread=re.search(r'PDF polizza letti (\d+)/(\d+)', ev)
  if mread and int(mread.group(2))>=5 and int(mread.group(1))==0:
    flags.append('PDFS_FOUND_NONE_READ')
  if 'SELF_INSURANCE' in ev.upper() or re.search(r'autoassicur', ev, re.I):
    flags.append('SI_MENTION_IN_EVIDENCE')
  if flags:
    suspect.append({
      'id': lid,
      'company': r.get('companyName'),
      'flags': flags,
      'n': n,
      'website': r.get('website'),
    })
    for f in flags:
      buckets[f.split('=')[0] if '=' in f else f]+=1

print(json.dumps({
  'hot_total': len(hots),
  'suspect_any_flag': len(suspect),
  'suspect_pct_of_hot': round(100*len(suspect)/max(1,len(hots)), 1),
  'flag_buckets': dict(buckets),
  'was_legacy_pub_now_hot': sum(1 for s in suspect if 'WAS_LEGACY_PUB' in s['flags']),
  'samples_legacy_pub_hot': [s for s in suspect if 'WAS_LEGACY_PUB' in s['flags']][:10],
  'samples_si_mention': [s for s in suspect if 'SI_MENTION_IN_EVIDENCE' in s['flags']][:8],
  'samples_small_crawl': [s for s in suspect if any(x.startswith('SMALL_CRAWL') for x in s['flags'])][:8],
}, indent=2, ensure_ascii=False))
print('\nNOTE: suspect flags != confirmed false HOT. Confirmed FP need human audit.')
con.close()
PY
