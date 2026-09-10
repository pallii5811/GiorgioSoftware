#!/usr/bin/env bash
# READ-ONLY: why commercial worker outcomes stay RETRY_PENDING
set -uo pipefail

echo "======== 1. Recent worker outcomes that LOOK commercial but lead_done=retry ========"
python3 <<'PY'
import json
from collections import Counter
from pathlib import Path

data = Path('/opt/leadsniper-revalidate/logs/systemd-revalidate.log').read_bytes()[-6_000_000:].decode('utf-8','ignore').splitlines()

# pair worker_done -> following lead_done for same id
commercial = {
  'HOT_VERIFIED','PUBLISHED_CURRENT','PUBLISHED_DATE_UNKNOWN','PUBLISHED_EXPIRED',
  'SELF_INSURANCE_VERIFIED','REVIEW_HUMAN','TECHNICAL_BLOCKED'
}
worker_by_id = {}
mismatch = Counter()
examples = []
for line in data:
    if not line.strip().startswith('{'): continue
    try: o=json.loads(line.strip())
    except: continue
    ev=o.get('event')
    if ev=='worker_done':
        worker_by_id[o.get('id')]=o
    elif ev=='lead_done':
        wid=o.get('id')
        w=worker_by_id.get(wid)
        if not w: continue
        wst=w.get('processingState')
        lst=o.get('processingState')
        kind=o.get('kind')
        if wst in commercial and (lst=='RETRY_PENDING' or kind=='retry'):
            key=f"worker={wst} -> parent={lst} reason={w.get('reasonCode')}"
            mismatch[key]+=1
            if len(examples)<12:
                examples.append({
                  'id': wid,
                  'worker_state': wst,
                  'worker_reason': w.get('reasonCode'),
                  'worker_wallMs': w.get('wallMs'),
                  'parent_state': lst,
                  'parent_kind': kind,
                  'terminal': o.get('terminal'),
                  'retry': o.get('retry'),
                })
        elif wst in commercial and kind=='terminal':
            mismatch[f"OK worker={wst} -> terminal"]+=1

print('mismatch_counts', json.dumps(dict(mismatch.most_common(20)), indent=2))
print('examples_forced_back_to_retry:')
for e in examples:
    print(json.dumps(e, ensure_ascii=False))
PY

echo
echo "======== 2. Inspect one such result file + retryQueue entry ========"
python3 <<'PY'
import json
from pathlib import Path
# use Clinica Sant'Anna from previous log if present
lid='cmqp7u72b00072lzge6nefcil'
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
print('in_terminal', lid in (cp.get('terminal') or {}))
print('in_retry', lid in (cp.get('retryQueue') or {}))
if lid in (cp.get('retryQueue') or {}):
    print('retry_entry', json.dumps(cp['retryQueue'][lid], indent=2, ensure_ascii=False)[:1200])
p=Path(f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json')
if p.exists():
    r=json.loads(p.read_text())
    keep={k:r.get(k) for k in [
      'companyName','website','processingState','newVerdict','businessVerdict','reasonCode',
      'policyFound','policyCompany','policyNumber','crawlComplete','dualDisagreement','error',
      'fullEvidence'
    ]}
    if keep.get('fullEvidence'):
        keep['fullEvidence']=str(keep['fullEvidence'])[:500]
    print('result', json.dumps(keep, indent=2, ensure_ascii=False))
PY

echo
echo "======== 3. Parent classify hooks in production-revalidate-sanita-v3.mjs ========"
# show logic around classifyResult / SELF_INSURANCE / crawlComplete forcing retry
grep -n 'classifyResult\|crawlComplete\|SELF_INSURANCE\|RETRY_PENDING\|RECERTIFICATION\|SITE_COVERAGE\|FRONTIER_INCOMPLETE\|kind === \"retry\"\|kind==\"retry\"' \
  /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-v3.mjs | head -60

echo
echo "======== 4. classifyResult source ========"
sed -n '50,120p' /opt/leadsniper-revalidate/app/scripts/revalidate-checkpoint-v3.mjs
