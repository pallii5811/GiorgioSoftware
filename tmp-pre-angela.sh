#!/bin/bash
set -euo pipefail
cp -f /opt/leadsniper/src/lib/sanita/policy-scheda-extract.ts /opt/leadsniper-revalidate/app/src/lib/sanita/
cp -f /opt/leadsniper/src/lib/sanita/detector.ts /opt/leadsniper-revalidate/app/src/lib/sanita/
ls -la /opt/leadsniper/scripts/test-scheda-polizza-extract.mjs /opt/leadsniper/src/lib/sanita/fixtures/scheda-polizza-anon.ts
python3 <<'PY'
import json
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print('term', len(cp.get('terminal', {})))
print('retry', len(cp.get('retryQueue', {})))
print('ip', len(cp.get('inProgress', {})))
print('angela_term', cp.get('terminal', {}).get('cmqkld5s2009y108ejvgl7m92'))
print('angela_retry', cp.get('retryQueue', {}).get('cmqkld5s2009y108ejvgl7m92'))
print('pini', (cp.get('terminal', {}).get('cmqklex5q00bh108eq9blm01k') or {}).get('processingState'))
print('malz', (cp.get('terminal', {}).get('cmqktyimz000i111hygme29nh') or {}).get('processingState'))
PY
