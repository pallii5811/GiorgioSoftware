#!/usr/bin/env bash
set -euo pipefail
LID=cmqmd9ia000979g5c4fd95cmi
python3 - "$LID" <<'PY'
import json, sqlite3, os, sys, re
lid=sys.argv[1]
# shadow result
p=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
r=json.load(open(p))
ev=r.get('fullEvidence') or ''
print('=== SHADOW RESULT ===')
print(json.dumps({
  'company': r.get('companyName'),
  'processingState': r.get('processingState'),
  'businessVerdict': r.get('businessVerdict'),
  'newVerdict': r.get('newVerdict'),
  'policyFound': r.get('policyFound'),
  'policyCompany': r.get('policyCompany'),
  'policyNumber': r.get('policyNumber'),
  'crawlComplete': r.get('crawlComplete'),
  'reasonCode': r.get('reasonCode'),
}, indent=2, ensure_ascii=False))
# SI keywords in evidence
for kw in ['autoassicur', 'gestione diretta', '420172841', 'SELF_INSURANCE', 'PARS', 'risk']:
  if re.search(kw, ev, re.I):
    print('EV_HIT', kw)
# show matching lines
for line in ev.splitlines():
  if re.search(r'autoassicur|gestione diret|420172841|SELF_INSUR|polizza', line, re.I):
    print('LINE:', line[:240])

# live
con=sqlite3.connect('file:/opt/leadsniper/prisma/dev.db?mode=ro', uri=True)
con.row_factory=sqlite3.Row
live=con.execute('SELECT companyName, evidence, policyFound, policyCompany, policyNumber, policyExpiry FROM Lead WHERE id=?', (lid,)).fetchone()
print('=== LIVE ===')
print(json.dumps(dict(live), indent=2, ensure_ascii=False)[:2500])
# baseline csv
import csv
csvp='/opt/leadsniper-revalidate/app/docs/human-review/published-baseline-final/published-baseline.csv'
if os.path.isfile(csvp):
  for row in csv.DictReader(open(csvp, encoding='utf-8', errors='replace')):
    if row.get('leadId')==lid:
      print('=== BASELINE CSV ===')
      print(json.dumps({k:row.get(k) for k in ['companyName','verdict_storico','nuovo_risultato','compagnia','numero_polizza','documento','estratto','motivazione']}, indent=2, ensure_ascii=False)[:2000])
      break
PY
