#!/usr/bin/env bash
# Deploy UI SHA to Hetzner blue only — never touch giorgio-revalidate.
set -euo pipefail
SHA="${1:?commit sha}"
APP=/opt/leadsniper
REPO_DIR=/opt/leadsniper

echo "=== PRE ==="
echo "REVAL=$(systemctl is-active giorgio-revalidate || true)"
echo "PROCESSED=$(python3 -c 'import json;d=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print((d.get("stats") or {}).get("processed"))')"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-before-ui-sha.sha
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs | tee /tmp/worker-before-ui-sha.sha
sha256sum /opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json | tee /tmp/baseline-before-ui.sha

cd "$APP"
git fetch origin
git checkout -f "$SHA"
printf '%s\n' "$SHA" > "$APP/RELEASE_SHA"

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
echo "UI_SHA=$(cat $APP/RELEASE_SHA)"
echo "GIT_HEAD=$(git rev-parse HEAD)"
sha256sum /opt/leadsniper-revalidate/data/revalidation/checkpoint.json | tee /tmp/cp-after-ui-sha.sha
sha256sum /opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs | tee /tmp/worker-after-ui-sha.sha
sha256sum /opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json | tee /tmp/baseline-after-ui.sha
diff -u /tmp/worker-before-ui-sha.sha /tmp/worker-after-ui-sha.sha
diff -u /tmp/baseline-before-ui.sha /tmp/baseline-after-ui.sha
# checkpoint may advance while scan runs — report both, do not fail
echo "PROCESSED_AFTER=$(python3 -c 'import json;d=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"));print((d.get("stats") or {}).get("processed"))')"
curl -sS --max-time 30 http://127.0.0.1:3000/api/sanita/archive-revalidation
echo
curl -sS --max-time 60 'http://127.0.0.1:3000/api/sanita?includePending=1&includeAll=1' -o /tmp/sanita-after-ui.json
python3 - <<'PY'
import json
j=json.load(open("/tmp/sanita-after-ui.json"))
k=(j.get("meta") or {}).get("kpis") or {}
c=k.get("commercial") or {}
print(json.dumps({
  "dbTotal": (j.get("meta") or {}).get("dbTotal"),
  "actionable": k.get("actionable"),
  "notYetCertified": k.get("notYetCertified"),
  "commercial": c,
  "sum": sum(c.get(x,0) for x in ("policyValid","policyExpired","dateUnknown","absenceCertified")),
}, indent=2))
PY
echo "=== HETZNER UI DEPLOY DONE ==="
