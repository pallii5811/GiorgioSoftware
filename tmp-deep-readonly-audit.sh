#!/usr/bin/env bash
# READ-ONLY deep audit. No mutations.
set -uo pipefail
echo "======== 1. SERVICE ========"
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate -p ActiveState -p SubState -p ActiveEnterTimestamp -p NRestarts -p MemoryCurrent -p MemoryPeak 2>/dev/null
echo
echo "======== 2. UNIT ENV (concurrency / caps) ========"
systemctl show giorgio-revalidate -p Environment | tr ' ' '\n' | grep -E 'CONCURRENCY|WORKERS|APPLY|CRAWL|WALL|HTML|OCR|DUAL|CHECKPOINT' | head -40
echo
echo "======== 3. CHECKPOINT CORE ========"
python3 <<'PY'
import json, time, os
from collections import Counter
from pathlib import Path
from datetime import datetime, timezone
CP=Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json')
cp=json.loads(CP.read_text())
term=cp.get('terminal') or {}
rq=cp.get('retryQueue') or {}
inp=cp.get('inProgress') or {}
att=cp.get('attempts') or {}
print('path', CP)
print('mtime', datetime.fromtimestamp(CP.stat().st_mtime, timezone.utc).isoformat())
print('age_sec', int(time.time()-CP.stat().st_mtime))
print('updatedAt', cp.get('updatedAt'))
print('keys', sorted(cp.keys()))
print('stats', cp.get('stats'))
print('terminal', len(term), dict(Counter(v.get('processingState') for v in term.values()).most_common()))
print('retry', len(rq))
print('inProgress', len(inp), list(inp.keys())[:5])
# attempts of retry leads
atts=[int((rq[k].get('attempts') if isinstance(rq.get(k),dict) else 0) or att.get(k) or 0) for k in rq]
if atts:
  print('retry_attempts min/med/max', min(atts), sorted(atts)[len(atts)//2], max(atts))
# when terminals finished
fins=[]
for v in term.values():
  fa=v.get('finishedAt')
  if fa: fins.append(fa)
fins.sort()
print('first_terminal', fins[0] if fins else None)
print('last_terminal', fins[-1] if fins else None)
print('terminals_last_2h', sum(1 for f in fins if f>='2026-07-28T18:'))
print('terminals_last_6h', sum(1 for f in fins if f>='2026-07-28T14:'))
# reason families
fam=Counter()
for v in rq.values():
  blob=f"{v.get('lastReason')} {v.get('lastError')}"
  u=blob.upper()
  if 'IDENTITY' in u: fam['IDENTITY']+=1
  elif 'RECERT' in u: fam['RECERTIFICATION']+=1
  elif 'RETRY_PENDING' in u: fam['RETRY_PENDING']+=1
  elif 'REVIEW' in u: fam['REVIEW_IN_RETRY']+=1
  elif 'FRONTIER' in u or 'INCOMPLETE' in u: fam['INCOMPLETE']+=1
  elif 'PDF' in u: fam['PDF']+=1
  elif 'WALL' in u or 'TIMEOUT' in u: fam['TIMEOUT']+=1
  elif 'SITEMAP' in u: fam['SITEMAP']+=1
  elif 'CAP' in u: fam['CAP']+=1
  elif 'DUAL' in u: fam['DUAL']+=1
  elif 'PUBLISHED' in u: fam['PUBLISHED_TAG']+=1
  elif 'SELF_INSUR' in u: fam['SI_TAG']+=1
  else: fam[blob.split(':')[0][:40]]+=1
print('retry_families', dict(fam.most_common(20)))
# strategy
print('strategies', dict(Counter(str(v.get('strategy')) for v in rq.values()).most_common()))
PY
echo
echo "======== 4. CHECKPOINT BACKUPS / HISTORY ========"
ls -lat --time-style=long-iso /opt/leadsniper-revalidate/data/revalidation/checkpoint* 2>/dev/null | head -20
ls -lat --time-style=long-iso /opt/leadsniper-revalidate/data/revalidation/*.json 2>/dev/null | head -15
echo
echo "======== 5. APP LOG FILES ========"
ls -lat --time-style=long-iso /opt/leadsniper-revalidate/*.log /opt/leadsniper-revalidate/logs 2>/dev/null | head -20
# StandardOutput append path from unit
systemctl cat giorgio-revalidate 2>/dev/null | head -80
echo
echo "======== 6. JOURNAL LAST 2H (errors / done) ========"
journalctl -u giorgio-revalidate --since '2026-07-28 14:00:00' --no-pager -o short-iso 2>/dev/null | tail -80
echo
echo "======== 7. JOURNAL COUNTS ========"
journalctl -u giorgio-revalidate --since '2026-07-28 00:00:00' --no-pager -o cat 2>/dev/null | grep -ciE 'oom|kill|error|fail|identity|terminal|lead_done|published' || true
journalctl -u giorgio-revalidate --since '2026-07-28 00:00:00' --no-pager -o cat 2>/dev/null | grep -iE 'oom-kill|Failed with result' | tail -10
echo
echo "======== 8. LIVE WORKER / FRONTIER ACTIVITY ========"
ps -eo pid,etimes,pcpu,pmem,args | grep -E 'revalidate|chrome' | grep -v grep | head -15
echo 'newest frontiers:'
ls -lat --time-style=+%H:%M:%S /opt/leadsniper-revalidate/data/revalidation/frontiers/*.sqlite 2>/dev/null | head -8
echo 'newest results:'
ls -lat --time-style=+%H:%M:%S /opt/leadsniper-revalidate/data/revalidation/results/*.json 2>/dev/null | head -10
echo
echo "======== 9. RELEASE / COMUNI CHANGE HINTS ========"
cat /opt/leadsniper-revalidate/app/RELEASE_SHA 2>/dev/null
ls -lat --time-style=long-iso /opt/leadsniper-revalidate/app/src/lib/sanita/*.ts 2>/dev/null | head -25
# comuni/region related files
find /opt/leadsniper-revalidate/app -iname '*comun*' -o -iname '*region*' 2>/dev/null | head -30
echo
echo "======== 10. FREE MEM ========"
free -h
