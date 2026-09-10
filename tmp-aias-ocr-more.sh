#!/usr/bin/env bash
set -euo pipefail
FP=/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqmd9ia000979g5c4fd95cmi-1784895741811.sqlite
python3 - <<'PY'
import sqlite3, re
con=sqlite3.connect('/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqmd9ia000979g5c4fd95cmi-1784895741811.sqlite')
row=con.execute("""
SELECT normalizedText FROM CrawlNodeEvidence
WHERE canonicalUrl LIKE '%piano-annuale-risk%'
""").fetchone()
text=row[0] if row else ''
print('len', len(text or ''))
print(text)
# keyword scan
for kw in ['auto','assicur','polizza','gestione','diretta','fondo','rischio','Gelli','Art']:
  print(kw, (text or '').lower().count(kw.lower()))
PY
# page count
pdfinfo /tmp/aias-si/aias-pars.pdf | grep Pages
# OCR remaining pages in batches - find insurance section
cd /tmp/aias-si
PAGES=$(pdfinfo aias-pars.pdf | awk '/Pages/{print $2}')
echo PAGES=$PAGES
# OCR all pages but only keep hits (can be slow) - do 9-25
pdftoppm -f 9 -l 25 -png -r 180 aias-pars.pdf q 2>/dev/null
for f in q-*.png; do
  [[ -f "$f" ]] || continue
  out=$(tesseract "$f" stdout -l ita 2>/dev/null || true)
  echo "$out" > "${f}.txt"
  if echo "$out" | grep -qiE 'autoassicur|gestione diretta|autoritenz|posizione assicur|polizza n'; then
    echo "HIT $f"
    echo "$out" | grep -niE 'autoassicur|gestione diretta|autoritenz|posizione assicur|polizza' | head -20
  fi
done
grep -nihE 'autoassicur|gestione diretta|autoritenz|posizione assicur' q-*.txt p-*.txt 2>/dev/null | head -40 || echo STILL_NONE
