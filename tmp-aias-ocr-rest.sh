#!/usr/bin/env bash
set -euo pipefail
cd /tmp/aias-si
ls q-*.png 2>/dev/null | wc -l
ls p-*.png 2>/dev/null | wc -l
# OCR pages 15-22 if missing
pdftoppm -f 15 -l 22 -png -r 200 aias-pars.pdf r 2>/dev/null
for f in r-*.png q-*.png; do
  [[ -f "$f" ]] || continue
  [[ -f "${f}.txt" ]] && continue
  tesseract "$f" "${f%.png}" -l ita 2>/dev/null || true
done
echo '=== ALL SI SEARCH ==='
grep -nihE 'autoassicur|gestione[[:space:]]+diretta|autoritenz|fondo[[:space:]]+intern|regime di auto' ./*.txt 2>/dev/null | head -50 || echo NONE
echo '=== polizza mentions ==='
grep -nihE 'polizza|assicuraz' ./*.txt 2>/dev/null | head -40 || true
