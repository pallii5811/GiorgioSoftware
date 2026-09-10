#!/usr/bin/env bash
set -euo pipefail
LID=cmqmd9ia000979g5c4fd95cmi
FP=/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqmd9ia000979g5c4fd95cmi-1784895741811.sqlite
python3 - <<PY
import sqlite3, json
con=sqlite3.connect('$FP')
con.row_factory=sqlite3.Row
# node for risk management pdf
rows=con.execute("""
SELECT n.canonicalUrl, n.state, n.httpStatus, n.resourceType, n.exclusionReason,
       e.ocrStatus, e.policyFound, length(e.normalizedText) as nlen, length(e.policyText) as plen,
       substr(e.normalizedText,1,500) as nhead,
       substr(e.policyText,1,800) as phead
FROM CrawlFrontierNode n
LEFT JOIN CrawlNodeEvidence e ON e.nodeId=n.id
WHERE n.canonicalUrl LIKE '%piano-annuale-risk%' OR n.canonicalUrl LIKE '%assicurazione%'
""").fetchall()
for r in rows:
  print('---')
  print(dict(r))
# any evidence with autoassicur
hits=con.execute("""
SELECT canonicalUrl, ocrStatus, policyFound,
  instr(lower(coalesce(normalizedText,'')), 'autoassicur') as a1,
  instr(lower(coalesce(policyText,'')), 'autoassicur') as a2,
  instr(lower(coalesce(normalizedText,'')), 'gestione diretta') as g1
FROM CrawlNodeEvidence
WHERE lower(coalesce(normalizedText,'')) LIKE '%autoassicur%'
   OR lower(coalesce(policyText,'')) LIKE '%autoassicur%'
   OR lower(coalesce(normalizedText,'')) LIKE '%gestione diretta%'
LIMIT 20
""").fetchall()
print('SI_HITS', len(hits))
for h in hits:
  print(dict(h))
PY

# OCR pages that likely have insurance section - try more pages
cd /tmp/aias-si
# pdf pages count
pdfinfo aias-pars.pdf 2>/dev/null | head -10 || true
# OCR pages 1-8
pdftoppm -f 1 -l 8 -png -r 200 aias-pars.pdf p 2>/dev/null
for f in p-*.png; do
  echo "==== $f ===="
  tesseract "$f" stdout -l ita+eng 2>/dev/null | tee "${f}.txt" | grep -niE 'autoassicur|gestione diretta|autoritenz|polizza|assicuraz|42017' | head -15 || true
done
echo '--- aggregate ---'
grep -nihE 'autoassicur|gestione diretta|autoritenz' p-*.txt 2>/dev/null | head -30 || echo 'NO_SI_IN_OCR_P1_8'
