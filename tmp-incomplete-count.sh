#!/usr/bin/env bash
python3 <<'PY'
import json, collections, re
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
rq=cp.get('retryQueue') or {}
term=cp.get('terminal') or {}
ip=cp.get('inProgress') or {}

def bucket(err):
  e=str(err or '').upper()
  if re.search(r'FRONTIER_INCOMPLETE|CRAWL_CAP|PDF_UNPROCESSED|SITEMAP|LEAD_WALL', e):
    return 'crawl_incomplete'
  if re.search(r'ANALYZE|PLAYWRIGHT|EXECUTABLE|OCR_', e):
    return 'engine_requeue'
  if re.search(r'IDENTITY', e):
    return 'identity'
  if re.search(r'DUAL|REVIEW', e):
    return 'reviewish'
  return 'other'

b=collections.Counter()
for v in rq.values():
  b[bucket(v.get('lastReason') or v.get('lastError'))]+=1

print(json.dumps({
  'terminal': len(term),
  'inProgress': len(ip),
  'retry_total': len(rq),
  'of_which_true_crawl_incomplete': b['crawl_incomplete'],
  'of_which_engine_requeue_ex_analyze': b['engine_requeue'],
  'of_which_identity': b['identity'],
  'of_which_other': b['other']+b['reviewish'],
  'breakdown': dict(b),
}, indent=2))
PY
systemctl is-active giorgio-revalidate
