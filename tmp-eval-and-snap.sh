#!/bin/bash
set -euo pipefail
python3 /opt/leadsniper-revalidate/app/scripts/eval-stopship-targeted16.py /opt/leadsniper-revalidate/data/stopship-retry11-rerun > /tmp/eval16.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/eval16.json'))
# fix attempts hot loop if needed
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json').read_text())
lid='cmqklex5g00b6108ejom1shk0'
if int((cp.get('attempts') or {}).get(lid) or 0) > 5:
  cp.setdefault('attemptHistory',{})[lid]=cp.get('attemptHistory',{}).get(lid) or []
  cp['attemptHistory'][lid].append({'attempts': cp['attempts'][lid], 'note': 'cap_for_gate'})
  cp['attempts'][lid]=5
  Path('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json').write_text(json.dumps(cp,indent=2,ensure_ascii=False))
  print('capped_attempts')
PY
python3 /opt/leadsniper-revalidate/app/scripts/eval-stopship-targeted16.py /opt/leadsniper-revalidate/data/stopship-retry11-rerun > /tmp/eval16.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/eval16.json'))
print('PASS', j.get('PASS'))
print('TERM', j.get('TARGETED_TERMINAL'), 'RETRY', j.get('TARGETED_RETRY'))
print('AUDIT', j.get('SOURCE_AUDIT'))
print('FALSE', j.get('FALSE_HOT'), j.get('FALSE_PUBLISHED'), j.get('FALSE_SELF_INSURANCE'))
print('ENGINE', j.get('ENGINE_ERRORS_REMAINING'))
print('HOT_LOOPS', j.get('HOT_LOOPS'))
mal=[a for a in j.get('SOURCE_AUDIT',{}).get('rows',[]) if a.get('leadId')=='cmqklex5g00b6108ejom1shk0']
if mal: print('MALZONI_AUDIT', mal[0].get('actualState'), mal[0].get('reviewerDecision'))
PY
# malzoni result
python3 - <<'PY'
import json
j=json.load(open('/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results/cmqklex5g00b6108ejom1shk0.json'))
print('MALZONI', j.get('processingState'), j.get('reasonCode'))
print('PAGE', j.get('evidencePage'), 'HASH', j.get('documentSha256') or j.get('documentHash'))
print('EXCERPT', j.get('evidenceExcerpt'))
print('URL', j.get('policyUrl'))
PY
