#!/usr/bin/env bash
# Deploy stop-ship orchestrator patch to revalidate tree ONLY. Never starts 877.
set -euo pipefail
STAGING=/tmp/stopship-patch
APP=/opt/leadsniper-revalidate/app
test -f "$STAGING/scripts/production-revalidate-sanita-v3.mjs"
test -f "$STAGING/scripts/revalidate-checkpoint-v3.mjs"

# Prove worker file untouched before/after
WORKER="$APP/scripts/production-revalidate-sanita-worker.mjs"
sha256sum "$WORKER" | tee /tmp/stopship-forensic/worker-before-patch.sha
EXPECTED=f8843a46bfb1b3734116306216ee3d3bf52171fb2a45fb27f3331c9175acf071
grep -q "$EXPECTED" /tmp/stopship-forensic/worker-before-patch.sha

TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/leadsniper-revalidate/backups/stopship-orch-$TS
mkdir -p "$BK"
cp -a "$APP/scripts/production-revalidate-sanita-v3.mjs" "$BK/"
cp -a "$APP/scripts/revalidate-checkpoint-v3.mjs" "$BK/"

install -m 0644 "$STAGING/scripts/production-revalidate-sanita-v3.mjs" "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 "$STAGING/scripts/revalidate-checkpoint-v3.mjs" "$APP/scripts/revalidate-checkpoint-v3.mjs"

sha256sum "$WORKER" | tee /tmp/stopship-forensic/worker-after-patch.sha
diff -u /tmp/stopship-forensic/worker-before-patch.sha /tmp/stopship-forensic/worker-after-patch.sha
# quick syntax check
cd "$APP"
npx tsx -e "import('./scripts/revalidate-checkpoint-v3.mjs').then(m=>console.log('MAX',m.MAX_RETRY_ATTEMPTS,'TB',m.isTerminalState('TECHNICAL_BLOCKED'),'HOT',m.isTerminalState('HOT_VERIFIED')))"
echo PATCH_DEPLOY_OK
