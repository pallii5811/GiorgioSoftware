#!/bin/bash
set -euo pipefail
# discover PARS links
for u in \
  'https://malzonicenter.com/trasparenza/' \
  'https://www.malzonicenter.com/trasparenza/' \
  'https://www.malzoni.it/' \
  'https://malzoni.it/' \
  'https://www.radiosurgerymalzoni.it/it/societa-trasparente' \
  'https://www.radiosurgerymalzoni.it/societa-trasparente'
 do
  echo "=== $u ==="
  curl -sL -m 25 -A 'Mozilla/5.0' "$u" | tr '"' '\n' | grep -iE 'pars|autoassic|\.pdf' | head -30 || true
done
# try known filename variants
for u in \
  'https://malzonicenter.com/wp-content/uploads/PARS_Malzoni-Research-Hospital_2026.pdf' \
  'https://www.malzonicenter.com/wp-content/uploads/2026/01/PARS_Malzoni-Research-Hospital_2026.pdf' \
  'https://www.malzoni.it/wp-content/uploads/PARS-2026-Malzoni-Research-Hospital-S.p.A.pdf' \
  'https://www.malzoni.it/wp-content/uploads/PARS_Malzoni-Research-Hospital_2026.pdf'
 do
  code=$(curl -sL -m 20 -o /tmp/cand.pdf -w '%{http_code}' -A 'Mozilla/5.0' "$u" || echo fail)
  ft=$(file -b /tmp/cand.pdf 2>/dev/null || true)
  echo "TRY $code $ft $u"
  if echo "$ft" | grep -qi PDF; then
    echo "FOUND $u"
    cp /tmp/cand.pdf /tmp/PARS_Malzoni_FOUND.pdf
    pdftotext -f 6 -l 6 /tmp/PARS_Malzoni_FOUND.pdf - | head -50
    sha256sum /tmp/PARS_Malzoni_FOUND.pdf
  fi
done
