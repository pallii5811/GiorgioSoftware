#!/usr/bin/env bash
# Progressive apply all certified PUBLISHED_* results from priority batch (CRM-safe).
set -euo pipefail
OUT=/opt/leadsniper-revalidate/data/revalidation-published-priority
APP=/opt/leadsniper-revalidate/app
META=/opt/leadsniper/backups/giorgio-live-20260720T165135Z.meta.json
LIVE=file:/opt/leadsniper/prisma/dev.db
cd "$APP"
IDS=$(python3 - <<'PY'
import json,os
res="/opt/leadsniper-revalidate/data/revalidation-published-priority/results"
ids=[]
for f in sorted(os.listdir(res)):
  if not f.endswith(".json") or ".p1." in f: continue
  r=json.load(open(os.path.join(res,f)))
  if r.get("processingState") in ("PUBLISHED_CURRENT","PUBLISHED_EXPIRED","PUBLISHED_DATE_UNKNOWN"):
    ids.append(r["id"])
print(",".join(ids))
PY
)
echo "APPLY_IDS=$IDS"
if [ -z "$IDS" ]; then
  echo "NONE"
  exit 0
fi
# dry-run first
APPLY_IDS="$IDS" APPLY_LIVE=0 REVALIDATE_RESULTS_DIR="$OUT/results" \
  npx tsx scripts/production-apply-certified-lead.mjs
# live apply
APPLY_IDS="$IDS" APPLY_LIVE=1 \
  BACKUP_META_PATH="$META" \
  LIVE_DATABASE_URL="$LIVE" \
  REVALIDATE_RESULTS_DIR="$OUT/results" \
  npx tsx scripts/production-apply-certified-lead.mjs

# verify commercial queue counts
python3 - <<'PY'
import json,urllib.request
for q in ["includePending=1","includePending=1&includeAll=1","includePending=1&actionable=1"]:
  with urllib.request.urlopen(f"http://127.0.0.1:3000/api/sanita?{q}", timeout=30) as r:
    j=json.load(r)
  m=j.get("meta") or {}
  print(q, "returned", len(j.get("data") or []), "actionable", m.get("actionableCount"), "dbTotal", m.get("dbTotal"))
PY
echo "PROGRESSIVE_APPLY_OK"
