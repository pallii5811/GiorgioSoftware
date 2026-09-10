#!/bin/bash
set -uo pipefail
UI=/opt/leadsniper
APP=/opt/leadsniper-revalidate/app
echo "RELEASE=$(cat $UI/RELEASE_SHA)"
echo "HETZNER_URL_CONST:"
grep -n 'HETZNER_SCAN_ENGINE' $UI/src/lib/sanita/scan-engine-url.ts || true
echo "--- sha256 key files UI ---"
for f in \
  scripts/production-revalidate-sanita-v3.mjs \
  scripts/production-revalidate-sanita-worker.mjs \
  scripts/revalidate-checkpoint-v3.mjs \
  src/lib/sanita/self-insurance.ts \
  src/lib/sanita/scan-engine-url.ts \
  src/components/sanita-leads.tsx \
  scripts/test-regression-corpus.mjs
 do
  if [[ -f "$UI/$f" ]]; then
    echo -n "$f "; sha256sum "$UI/$f" | awk '{print $1}'
  else
    echo "$f MISSING"
  fi
done
echo "--- grep patches in v3 ---"
grep -nE 'prepareFrontierForRetry|FORCE_FRESH|resume_boost|pending.?0|clear_caps|soft concurrency|never pin' \
  $UI/scripts/production-revalidate-sanita-v3.mjs | head -40 || true
echo "--- service active ---"
systemctl is-active giorgio-revalidate; systemctl is-enabled giorgio-revalidate
echo "--- checkpoint ---"
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')
print(p.read_text()[:500] if p.exists() else 'NO_CP')
PY
echo "--- playwright chromium launch executablePath? ---"
grep -n executablePath $UI/src/lib/sanita/crawl-slice-runner.ts $UI/src/lib/sanita/playwright-maps.ts 2>/dev/null | head -10 || true
