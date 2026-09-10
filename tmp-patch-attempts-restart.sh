#!/bin/bash
set -euo pipefail
# Patch attempts guard + kill crash loop + restart canary only
systemctl stop giorgio-revalidate || true
pkill -f 'production-revalidate-sanita-v3.mjs' 2>/dev/null || true
sleep 2

# ensure attempts init in migrate early-return
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/leadsniper-revalidate/app/scripts/revalidate-checkpoint-v3.mjs')
t=p.read_text(encoding='utf-8')
old='''  if (cp?.version >= 3 && cp.terminal && cp.retryQueue) {
    cp.testedCodeSha = cp.testedCodeSha || testedCodeSha;
    return { checkpoint: cp, migrated: 0, terminal: Object.keys(cp.terminal).length, retry: Object.keys(cp.retryQueue).length };
  }'''
new='''  if (cp?.version >= 3 && cp.terminal && cp.retryQueue) {
    cp.testedCodeSha = cp.testedCodeSha || testedCodeSha;
    // Incomplete hand-written / reset checkpoints may omit attempts.
    if (!cp.attempts || typeof cp.attempts !== "object") cp.attempts = {};
    if (!cp.inProgress || typeof cp.inProgress !== "object") cp.inProgress = {};
    return { checkpoint: cp, migrated: 0, terminal: Object.keys(cp.terminal).length, retry: Object.keys(cp.retryQueue).length };
  }'''
if old not in t:
  if 'Incomplete hand-written' in t:
    print('ALREADY_PATCHED')
  else:
    raise SystemExit('pattern not found')
else:
  p.write_text(t.replace(old,new,1),encoding='utf-8')
  print('PATCHED_APP')
# also UI tree copy if present
p2=Path('/opt/leadsniper/scripts/revalidate-checkpoint-v3.mjs')
if p2.exists():
  t2=p2.read_text(encoding='utf-8')
  if old in t2:
    p2.write_text(t2.replace(old,new,1),encoding='utf-8')
    print('PATCHED_UI')
  elif 'Incomplete hand-written' in t2:
    print('UI_ALREADY')
  else:
    print('UI_PATTERN_MISS')
PY

# kill old canary bash if still waiting
pkill -f '/tmp/canary3-gates.sh' 2>/dev/null || true
sleep 1
# refresh canary script
install -m 755 /tmp/canary3-gates.sh.new /tmp/canary3-gates.sh 2>/dev/null || true
nohup bash /tmp/canary3-gates.sh > /tmp/canary3-gates.log 2>&1 &
echo RESTARTED_PID=$!
sleep 3
head -25 /tmp/canary3-gates.log
systemctl is-active giorgio-revalidate || true
