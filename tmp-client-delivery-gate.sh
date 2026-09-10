#!/usr/bin/env bash
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
REAL_CHROME=/snap/chromium/current/usr/lib/chromium-browser/chrome
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
LIVE_DB=/opt/leadsniper/prisma/dev.db

echo '=== SERVICE ==='
systemctl is-active giorgio-revalidate
systemctl show giorgio-revalidate -p ActiveState -p SubState -p MainPID --no-pager

echo '=== ENV CHROME ==='
grep -E 'PLAYWRIGHT|CHROMIUM|APPLY|TOTAL_WORKERS|CONCURRENCY|DUAL' /etc/systemd/system/giorgio-revalidate.service | head -20

echo '=== RELEASE / FILES ==='
cat "$APP/RELEASE_SHA" 2>/dev/null || echo 'no RELEASE_SHA'
sha256sum "$APP/src/lib/sanita/playwright-launch.ts" "$APP/scripts/revalidate-checkpoint-v3.mjs" "$APP/scripts/production-revalidate-sanita-v3.mjs" | awk '{print $1, $2}'
head -5 "$APP/src/lib/sanita/playwright-launch.ts"
grep -n 'PLAYWRIGHT_NO_CHROMIUM\|snap/chromium/current' "$APP/src/lib/sanita/playwright-launch.ts" | head -5
grep -n 'ANALYZE_ERROR\|REVIEW_HUMAN' "$APP/scripts/revalidate-checkpoint-v3.mjs" | head -8

echo '=== LIVE DB SHA (must be stable / APPLY_LIVE=0) ==='
sha256sum "$LIVE_DB" | awk '{print $1}'
# check APPLY not writing
grep -E 'APPLY_LIVE|DISABLE_LIVE' /etc/systemd/system/giorgio-revalidate.service || true

echo '=== CHECKPOINT ==='
python3 <<'PY'
import json, collections, glob, os, time
cp=json.load(open('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json'))
rq=cp.get('retryQueue') or {}
print(json.dumps({
  'terminal': len(cp.get('terminal') or {}),
  'retry': len(rq),
  'inProgress': len(cp.get('inProgress') or {}),
  'stats': cp.get('stats'),
  'testedCodeSha': cp.get('testedCodeSha'),
}, indent=2))
errs=collections.Counter()
for v in rq.values():
  errs[str(v.get('lastReason') or v.get('lastError') or '?')[:80]] += 1
if errs:
  print('RETRY_REASONS', dict(errs))
# recent results last 10 min
now=time.time()
recent=[]
for f in glob.glob('/opt/leadsniper-revalidate/data/revalidation/results/*.json'):
  if f.endswith('.p1.json') or f.endswith('.p2.json'): continue
  mt=os.path.getmtime(f)
  if now-mt < 600:
    try:
      r=json.load(open(f))
      recent.append((mt, os.path.basename(f), r.get('processingState'), str(r.get('reasonCode') or r.get('error') or '')[:90]))
    except Exception: pass
recent.sort(reverse=True)
print('RECENT_RESULTS', len(recent))
for mt,name,ps,rc in recent[:12]:
  print(f'  {name} {ps} {rc}')
PY

echo '=== TESTS ==='
cd "$APP"
node scripts/test-stopship-no-tech-terminal.mjs
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$REAL_CHROME" CHROMIUM_PATH="$REAL_CHROME"
npx tsx scripts/test-playwright-chromium-smoke.mjs

echo '=== JOURNAL (no engine poison) ==='
journalctl -u giorgio-revalidate --since '10 min ago' --no-pager | grep -Ei 'ANALYZE_ERROR|Executable doesn|headless_shell|PLAYWRIGHT_NO|retry_ceiling|lead_error' | tail -30 || echo 'CLEAN_NO_ENGINE_ERRORS'
journalctl -u giorgio-revalidate --since '5 min ago' --no-pager | grep -E 'lead_done|boot|started|parent' | tail -20 || true
