#!/usr/bin/env bash
# Deploy Sanità v3 job controller to Hetzner blue — does NOT touch giorgio-revalidate/checkpoint/DB.
set -euo pipefail
SHA="${1:?SHA required}"
APP=/opt/leadsniper
STAGING=/tmp/sanita-jobs-v3-deploy

echo "=== PRE ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA_BEFORE=$(cat $APP/RELEASE_SHA 2>/dev/null || true)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-before-jobs.sha
stat -c '%y %s %n' /opt/leadsniper-revalidate/data/revalidation/checkpoint.json || true
ls -la "$STAGING"
for f in \
  src/lib/sanita/jobs.ts \
  src/lib/sanita/job-watchdog.ts \
  src/lib/sanita/job-certified-apply.ts \
  src/lib/sanita/apply-certified-terminal.ts \
  src/app/api/sanita/jobs/route.ts \
  src/components/sanita-leads.tsx \
  scripts/sanita-job-runner.mjs \
  scripts/production-apply-certified-lead.mjs
do
  test -f "$STAGING/$f"
done

TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/leadsniper/backups/sanita-jobs-pre-$TS
mkdir -p "$BK/src/lib/sanita" "$BK/src/app/api/sanita/jobs" "$BK/src/components" "$BK/scripts"
cp -a "$APP/src/lib/sanita/jobs.ts" "$BK/src/lib/sanita/" 2>/dev/null || true
cp -a "$APP/src/lib/sanita/apply-certified-terminal.ts" "$BK/src/lib/sanita/" 2>/dev/null || true
cp -a "$APP/src/components/sanita-leads.tsx" "$BK/src/components/" 2>/dev/null || true
cp -a "$APP/scripts/sanita-job-runner.mjs" "$BK/scripts/" 2>/dev/null || true
cp -a "$APP/scripts/production-apply-certified-lead.mjs" "$BK/scripts/" 2>/dev/null || true
echo "$BK"

install -D -m 0644 "$STAGING/src/lib/sanita/jobs.ts" "$APP/src/lib/sanita/jobs.ts"
install -D -m 0644 "$STAGING/src/lib/sanita/job-watchdog.ts" "$APP/src/lib/sanita/job-watchdog.ts"
install -D -m 0644 "$STAGING/src/lib/sanita/job-certified-apply.ts" "$APP/src/lib/sanita/job-certified-apply.ts"
install -D -m 0644 "$STAGING/src/lib/sanita/apply-certified-terminal.ts" "$APP/src/lib/sanita/apply-certified-terminal.ts"
install -D -m 0644 "$STAGING/src/app/api/sanita/jobs/route.ts" "$APP/src/app/api/sanita/jobs/route.ts"
install -D -m 0644 "$STAGING/src/app/api/sanita/jobs/[jobId]/route.ts" "$APP/src/app/api/sanita/jobs/[jobId]/route.ts"
install -D -m 0644 "$STAGING/src/app/api/sanita/jobs/[jobId]/cancel/route.ts" "$APP/src/app/api/sanita/jobs/[jobId]/cancel/route.ts"
install -m 0644 "$STAGING/src/components/sanita-leads.tsx" "$APP/src/components/sanita-leads.tsx"
install -m 0755 "$STAGING/scripts/sanita-job-runner.mjs" "$APP/scripts/sanita-job-runner.mjs"
install -m 0755 "$STAGING/scripts/production-apply-certified-lead.mjs" "$APP/scripts/production-apply-certified-lead.mjs"
mkdir -p "$APP/data/sanita-jobs"
printf '%s\n' "$SHA" > "$APP/RELEASE_SHA"

cd "$APP"
export DATABASE_URL='file:/opt/leadsniper/prisma/dev.db'
export SCAN_ENGINE_LOCAL=1
export OCR_ENABLED=1
export POLICY_EXHAUSTIVE=1
export SCAN_FAST=0
export ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=1
export NODE_ENV=production
npm run build
pm2 restart leadsniper-ui --update-env
sleep 8

echo "=== POST ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "BLUE_SHA_AFTER=$(cat $APP/RELEASE_SHA)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-after-jobs.sha
diff -u /tmp/cp-before-jobs.sha /tmp/cp-after-jobs.sha
curl -sS --max-time 20 -X POST 'http://127.0.0.1:3000/api/sanita/jobs' \
  -H 'Content-Type: application/json' \
  -d '{"mode":"single","region":"Campania","leadId":"cmqp9r0kg0002xk2835txrrlw"}' -o /tmp/job-probe.json || true
python3 - <<'PY'
import json
try:
  j=json.load(open("/tmp/job-probe.json"))
  print(json.dumps({"success": j.get("success"), "jobId": (j.get("job") or {}).get("jobId"), "status": (j.get("job") or {}).get("status")}, indent=2))
except Exception as e:
  print("job_probe_error", e)
PY
echo DEPLOY_SANITA_JOBS_V3_OK
