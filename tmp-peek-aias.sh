#!/usr/bin/env python3
import json, os
lid='cmqmd9ia000979g5c4fd95cmi'
# terminal meta
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
print('terminal', json.dumps(cp.get('terminal',{}).get(lid), indent=2))
p=f'/opt/leadsniper-revalidate/data/revalidation/results/{lid}.json'
if os.path.isfile(p):
  r=json.load(open(p))
  print(json.dumps({
    'company': r.get('companyName'),
    'processingState': r.get('processingState'),
    'newVerdict': r.get('newVerdict'),
    'reasonCode': r.get('reasonCode'),
    'crawlComplete': r.get('crawlComplete'),
    'policyFound': r.get('policyFound'),
    'error': r.get('error'),
    'evidence_tail': (r.get('fullEvidence') or '')[-1200:],
  }, indent=2, ensure_ascii=False)[:4000])
