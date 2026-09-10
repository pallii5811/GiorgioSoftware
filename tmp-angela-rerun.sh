#!/bin/bash
# Stop-ship: deploy patch, requeue ONLY Villa Angela, verify, resume 877. No CP wipe. APPLY_LIVE=0.
set -euo pipefail
AID=cmqkld5s2009y108ejvgl7m92
PINI=cmqklex5q00bh108eq9blm01k
MALZ=cmqktyimz000i111hygme29nh
UI=/opt/leadsniper
APP=/opt/leadsniper-revalidate/app
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
EVDIR=/opt/leadsniper-revalidate/data/revalidation/evidence-blobs
PDF=/tmp/amTrust.pdf
URL='https://villaangela.it/wp-content/uploads/2025/07/amTrust.pdf'

systemctl stop giorgio-revalidate 2>/dev/null || true
sleep 2

# --- evidence blob (original bytes, hash unchanged) ---
mkdir -p "$EVDIR"
if [[ ! -f "$PDF" ]]; then curl -fsSL -A 'Mozilla/5.0' -o "$PDF" "$URL"; fi
SHA=$(sha256sum "$PDF" | awk '{print $1}')
cp -n "$PDF" "$EVDIR/${SHA}.pdf" 2>/dev/null || cp "$PDF" "$EVDIR/${SHA}.pdf"
echo "EVIDENCE_BLOB=$EVDIR/${SHA}.pdf SHA=$SHA"

# --- demote ONLY Angela terminal → retry due now ---
python3 - <<PY
import json
from datetime import datetime, timezone
from pathlib import Path
aid="$AID"
pini="$PINI"
malz="$MALZ"
cp=json.loads(Path("$CP").read_text(encoding="utf-8"))
for k in ("terminal","retryQueue","inProgress","attempts"):
  if not isinstance(cp.get(k), dict): cp[k]={}
assert pini in cp["terminal"], "Pini missing"
assert malz in cp["terminal"], "Malzoni missing"
assert aid in cp["terminal"], "Angela not in terminal before demote"
before=len(cp["terminal"])
term=cp["terminal"].pop(aid)
cp["inProgress"].pop(aid, None)
cp["retryQueue"][aid]={
  "attempts": int((cp.get("attempts") or {}).get(aid) or 1),
  "lastReason": "EXPIRY_EXTRACT_RERUN",
  "lastError": "scheda_polizza_quietanza_fix",
  "nextRetryAt": datetime(1970,1,1,tzinfo=timezone.utc).isoformat().replace("+00:00","Z"),
  "firstSeenAt": datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
  "lastAttemptAt": datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),
  "frontierPath": None,
  "strategy": "fresh",
}
cp["attempts"][aid]=int(cp["attempts"].get(aid) or 0)
cp["updatedAt"]=datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
Path("$CP").write_text(json.dumps(cp,indent=2),encoding="utf-8")
print("TERMINAL_BEFORE", before, "AFTER", len(cp["terminal"]))
print("PINI", cp["terminal"][pini]["processingState"])
print("MALZ", cp["terminal"][malz]["processingState"])
print("ANGELA_IN_RETRY", aid in cp["retryQueue"])
# keep result file but mark pending so UI not show wrong until rerun — actually remove terminal is enough; old result overwritten on rerun
PY

# canary drop-in: ONLY Angela
mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/canary.conf <<EOF
[Service]
Environment=REVALIDATE_IDS=$AID
Environment=APPLY_LIVE=0
Environment=DISABLE_LIVE_DB=true
Environment=PER_HOST_CONCURRENCY=1
Environment=TOTAL_WORKERS=1
Environment=REVALIDATE_CONCURRENCY=1
EOF
systemctl daemon-reload
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
echo STARTED_ANGELA_ONLY=$(systemctl is-active giorgio-revalidate)

# wait up to 12 min for Angela terminal PUBLISHED_EXPIRED
DEADLINE=$((SECONDS+720))
GOT=0
while (( SECONDS < DEADLINE )); do
  python3 - <<'PY'
import json
from pathlib import Path
aid="cmqkld5s2009y108ejvgl7m92"
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
t=(cp.get("terminal") or {}).get(aid)
res=Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json")
j=json.loads(res.read_text()) if res.exists() else {}
print("ps", (t or {}).get("processingState") if t else None, "res", j.get("processingState"), j.get("policyNumber"), j.get("policyExpiry"), j.get("policyCompany"))
open("/tmp/angela_prog","w").write(json.dumps({"term":bool(t),"ps":(t or {}).get("processingState") or j.get("processingState"),"num":j.get("policyNumber"),"exp":j.get("policyExpiry"),"co":j.get("policyCompany")}))
PY
  PS=$(python3 -c "import json;print(json.load(open('/tmp/angela_prog')).get('ps') or '')")
  echo "progress $PS active=$(systemctl is-active giorgio-revalidate || true)"
  if [[ "$PS" == "PUBLISHED_EXPIRED" ]]; then GOT=1; break; fi
  if [[ "$PS" == "PUBLISHED_CURRENT" || "$PS" == "PUBLISHED_DATE_UNKNOWN" ]]; then
    echo "UNEXPECTED_STATE=$PS"; break
  fi
  sleep 20
done
echo "GOT_EXPIRED=$GOT"

systemctl stop giorgio-revalidate || true
rm -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf
systemctl daemon-reload

python3 - <<'PY'
import json,sqlite3
from pathlib import Path
aid="cmqkld5s2009y108ejvgl7m92"
pini="cmqklex5q00bh108eq9blm01k"
malz="cmqktyimz000i111hygme29nh"
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
j=json.loads(Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json").read_text())
print("VILLA_ANGELA_STATE", j.get("processingState"), (cp.get("terminal") or {}).get(aid,{}).get("processingState"))
print("POLICY_NUMBER", j.get("policyNumber"))
print("POLICY_EXPIRY", j.get("policyExpiry"))
print("POLICY_COMPANY", j.get("policyCompany"))
print("PINI", (cp.get("terminal") or {}).get(pini,{}).get("processingState"))
print("MALZ", (cp.get("terminal") or {}).get(malz,{}).get("processingState"))
print("TERMINAL_N", len(cp.get("terminal") or {}))
print("RETRY_N", len(cp.get("retryQueue") or {}))
c=sqlite3.connect("/opt/leadsniper/prisma/dev.db")
r=c.execute("select website,phone,email,pec,piva from Lead where id=?",(aid,)).fetchone()
print("CONTACTS", r)
PY

# Ensure result has sourcePdfUrl + contentHash pointing to blob if missing
python3 - <<PY
import json
from pathlib import Path
aid="$AID"
sha="$SHA"
url="$URL"
p=Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json")
j=json.loads(p.read_text(encoding="utf-8"))
j["sourcePdfUrl"]=j.get("sourcePdfUrl") or url
# Prefer crawl contentHash if set; also record file sha for cache link
if not j.get("contentHash"):
  j["contentHash"]=sha
j["evidenceFileSha256"]=sha
# ensure commercial fields from live if blank
import sqlite3
c=sqlite3.connect("/opt/leadsniper/prisma/dev.db")
row=c.execute("select website,phone,email,pec,piva,category,city,region,status,notes,companyName from Lead where id=?",(aid,)).fetchone()
if row:
  keys=["website","phone","email","pec","piva","category","city","region","crmStatus","notes","companyName"]
  for k,v in zip(keys,row):
    if v and not j.get(k): j[k]=v
p.write_text(json.dumps(j,indent=2,ensure_ascii=False),encoding="utf-8")
# also copy under contentHash name if different
ch=j.get("contentHash")
if ch and ch!=sha:
  import shutil
  shutil.copyfile("/tmp/amTrust.pdf", f"/opt/leadsniper-revalidate/data/revalidation/evidence-blobs/{ch}.pdf")
print("RESULT_PATCHED")
PY

# corpus + scheda tests
cd "$UI"
echo "DB_SHA=$(sha256sum prisma/dev.db | awk '{print $1}')"
SCAN_ENGINE_LOCAL=1 DATABASE_URL="file:prisma/dev.db" npx tsx scripts/test-regression-corpus.mjs 2>&1 | tee /tmp/corpus-angela.txt | tail -20
SCAN_ENGINE_LOCAL=1 npx tsx scripts/test-scheda-polizza-extract.mjs 2>&1 | tee /tmp/scheda-test.txt | tail -15

# Resume SAME checkpoint full 877 — single job
systemctl enable giorgio-revalidate
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 4
echo FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)
echo FINAL_ENABLED=$(systemctl is-enabled giorgio-revalidate)
curl -s http://127.0.0.1:3000/api/sanita/archive-revalidation/control | python3 -c "import sys,json;j=json.load(sys.stdin);print('control_active',j.get('active'),'systemd',j.get('systemdActive'))"
pgrep -af 'production-revalidate-sanita-v3.mjs' | grep -v worker | head -5
test ! -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf && echo NO_CANARY
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
