#!/usr/bin/env bash
set -euo pipefail
systemctl is-active giorgio-revalidate || true
python3 <<'PY'
import json, collections, os, re, glob
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
term=cp.get('terminal') or {}
rq=cp.get('retryQueue') or {}
ip=cp.get('inProgress') or {}
by=collections.Counter(v.get('processingState') for v in term.values())
print(json.dumps({
  'terminal': len(term),
  'retry': len(rq),
  'inProgress': len(ip),
  'by_state': dict(by),
  'stats': cp.get('stats'),
  'updatedAt': cp.get('updatedAt'),
}, indent=2))

# retry breakdown
err=collections.Counter()
strategies=collections.Counter()
force=0
for v in rq.values():
  err[str(v.get('lastReason') or v.get('lastError') or '?')[:70]] += 1
  strategies[str(v.get('strategy') or '?')] += 1
  if v.get('forceDue') or v.get('requeuedIncompleteReview') or v.get('requeuedFromFalseReview'):
    force += 1
print('RETRY_REASONS_TOP')
for k,n in err.most_common(15):
  print(f'  {n:3d}  {k}')
print('retry_marked_requeue', force)
print('strategies', dict(strategies))

# pub family detail
for ps in sorted(by):
  if re.search(r'PUBLISHED|SELF_INSURANCE|HOT|REVIEW|TECH', ps or ''):
    print(f'  state {ps}: {by[ps]}')

# how many of 877 done
print('approx_done_terminal_plus_inflight', len(term)+len(ip))
print('still_waiting_or_mid_crawl_in_retry_queue', len(rq))
PY
