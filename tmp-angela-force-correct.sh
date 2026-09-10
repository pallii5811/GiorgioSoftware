#!/bin/bash
# Force-correct Villa Angela from AmTrust PDF text via analyzePolicy (same patch).
# Preserves checkpoint otherwise. APPLY_LIVE=0. Then resume 877.
set -euo pipefail
AID=cmqkld5s2009y108ejvgl7m92
PINI=cmqklex5q00bh108eq9blm01k
MALZ=cmqktyimz000i111hygme29nh
APP=/opt/leadsniper-revalidate/app
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
PDF=/tmp/amTrust.pdf
URL='https://villaangela.it/wp-content/uploads/2025/07/amTrust.pdf'
EVDIR=/opt/leadsniper-revalidate/data/revalidation/evidence-blobs

systemctl stop giorgio-revalidate 2>/dev/null || true
rm -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf
systemctl daemon-reload

if [[ ! -f "$PDF" ]]; then curl -fsSL -A 'Mozilla/5.0' -o "$PDF" "$URL"; fi
SHA=$(sha256sum "$PDF" | awk '{print $1}')
mkdir -p "$EVDIR"
cp -f "$PDF" "$EVDIR/${SHA}.pdf"
pdftotext -layout "$PDF" /tmp/amtrust_for_analyze.txt

cd "$APP"
node --input-type=module <<'NODE'
import fs from "node:fs";
import { analyzePolicy } from "./src/lib/sanita/detector.ts";
import { extractSchedaPolizzaFields } from "./src/lib/sanita/policy-scheda-extract.ts";

const text = fs.readFileSync("/tmp/amtrust_for_analyze.txt", "utf8");
const scheda = extractSchedaPolizzaFields(text);
const a = analyzePolicy(text);
const ymd = (d) => (d ? d.toISOString().slice(0, 10) : null);
const out = {
  schedaNumber: scheda.policyNumber,
  schedaExpiry: ymd(scheda.expiry),
  schedaQuietanza: ymd(scheda.nextPayment),
  analyzeNumber: a.policyNumber,
  analyzeExpiry: ymd(a.expiry),
  company: a.company,
  policyFound: a.policyFound,
};
fs.writeFileSync("/tmp/angela_analyze.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
if (out.analyzeExpiry !== "2025-12-31" || out.analyzeNumber !== "RCI00010002744") {
  process.exit(2);
}
if (out.schedaQuietanza === out.schedaExpiry) process.exit(3);
NODE

python3 - <<'PY'
import json, sqlite3
from pathlib import Path
from datetime import datetime, timezone, date

aid="cmqkld5s2009y108ejvgl7m92"
pini="cmqklex5q00bh108eq9blm01k"
malz="cmqktyimz000i111hygme29nh"
url="https://villaangela.it/wp-content/uploads/2025/07/amTrust.pdf"
sha=Path("/tmp/amTrust.pdf").read_bytes()
import hashlib
file_sha=hashlib.sha256(Path("/tmp/amTrust.pdf").read_bytes()).hexdigest()
an=json.loads(Path("/tmp/angela_analyze.json").read_text())
assert an["analyzeExpiry"]=="2025-12-31"
assert an["analyzeNumber"]=="RCI00010002744"
assert an["schedaQuietanza"]=="2025-06-30"
assert an["schedaQuietanza"] != an["schedaExpiry"]

exp=date.fromisoformat(an["analyzeExpiry"])
today=date(2026,7,23)
assert exp < today
ps="PUBLISHED_EXPIRED"
now=datetime.now(timezone.utc).isoformat().replace("+00:00","Z")

c=sqlite3.connect("/opt/leadsniper/prisma/dev.db")
live=c.execute(
  "select companyName,website,phone,email,pec,piva,category,city,region,status,notes,evidence from Lead where id=?",
  (aid,),
).fetchone()
keys=["companyName","website","phone","email","pec","piva","category","city","region","crmStatus","notes","legacyEvidence"]
live_map=dict(zip(keys, live)) if live else {}

full=(
  f"[V:PUB] [PS:{ps}] [BV:{ps}] Polizza RC certificata da PDF: {url} "
  f"AmTrust · n. {an['analyzeNumber']} · scadenza {an['analyzeExpiry']} "
  f"(Periodo di Assicurazione; Prossima quietanza {an['schedaQuietanza']} NON usata come expiry). "
  f"SHA256 file: {file_sha}."
)

row={
  "id": aid,
  "companyName": live_map.get("companyName") or "Casa Di Cura Villa Angela S.r.l.",
  "city": live_map.get("city"),
  "region": live_map.get("region") or "Campania",
  "category": live_map.get("category"),
  "website": live_map.get("website"),
  "phone": live_map.get("phone"),
  "email": (live_map.get("email") or "").lstrip("/"),
  "pec": live_map.get("pec"),
  "piva": live_map.get("piva"),
  "crmStatus": live_map.get("crmStatus"),
  "notes": live_map.get("notes"),
  "processingState": ps,
  "businessVerdict": ps,
  "newVerdict": "PUBLISHED",
  "reasonCode": ps,
  "publishedSubtype": "policy_expired",
  "policyCompany": an["company"] or "AmTrust",
  "policyNumber": an["analyzeNumber"],
  "policyExpiry": an["analyzeExpiry"],
  "policyFound": True,
  "crawlComplete": True,
  "fullEvidence": full,
  "evidence": full,
  "contentHash": file_sha,
  "sourcePdfUrl": url,
  "evidenceFileSha256": file_sha,
  "finishedAt": now,
  "completedAt": now,
  "pass1": {
    "runId": "angela-scheda-fix",
    "processingState": ps,
    "token": "PUBLISHED",
    "policyFound": True,
    "crawlComplete": True,
    "error": None,
  },
}
Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json").write_text(
  json.dumps(row, indent=2, ensure_ascii=False), encoding="utf-8"
)

cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
for k in ("terminal","retryQueue","inProgress","attempts"):
  if not isinstance(cp.get(k), dict): cp[k]={}
assert pini in cp["terminal"] and cp["terminal"][pini]["processingState"]=="SELF_INSURANCE_VERIFIED"
assert malz in cp["terminal"] and cp["terminal"][malz]["processingState"]=="SELF_INSURANCE_VERIFIED"
cp["retryQueue"].pop(aid, None)
cp["inProgress"].pop(aid, None)
cp["terminal"][aid]={
  "finishedAt": now,
  "processingState": ps,
  "newVerdict": "PUBLISHED",
  "reasonCode": ps,
}
cp["attempts"][aid]=max(1, int(cp["attempts"].get(aid) or 0)+1)
cp["updatedAt"]=now
Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").write_text(json.dumps(cp, indent=2), encoding="utf-8")
print("VILLA_ANGELA_STATE", ps)
print("POLICY_NUMBER", an["analyzeNumber"])
print("POLICY_EXPIRY", an["analyzeExpiry"])
print("NEXT_PAYMENT_NOT_USED", an["schedaQuietanza"])
print("TERMINAL_N", len(cp["terminal"]))
print("PINI_OK", cp["terminal"][pini]["processingState"])
print("MALZ_OK", cp["terminal"][malz]["processingState"])
print("WEBSITE", row["website"])
print("PHONE", row["phone"])
print("EMAIL", row["email"])
print("PEC", row["pec"])
print("PIVA", row["piva"])
PY

cd /opt/leadsniper
SCAN_ENGINE_LOCAL=1 DATABASE_URL="file:prisma/dev.db" npx tsx scripts/test-regression-corpus.mjs 2>&1 | tee /tmp/corpus-angela2.txt | tail -12
SCAN_ENGINE_LOCAL=1 npx tsx scripts/test-scheda-polizza-extract.mjs 2>&1 | tee /tmp/scheda2.txt | tail -8
echo DB_SHA=$(sha256sum prisma/dev.db | awk '{print $1}')

# API checks
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' -o /tmp/run_a.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/run_a.json'))
rows=j.get('results') or []
print('RUN_N', len(rows))
for r in rows:
  if 'Angela' in (r.get('companyName') or ''):
    print('ANGELA_API', r.get('processingState'), r.get('publishedSubtype'), r.get('policyNumber'), r.get('policyExpiry'), r.get('website'), r.get('phone'), r.get('email'), r.get('pdfHash'))
PY
curl -s -o /dev/null -w "evidence_http=%{http_code}\n" "http://127.0.0.1:3000/api/sanita/archive-revalidation/evidence-file?sha=$(sha256sum /tmp/amTrust.pdf | awk '{print $1}')"

# Resume full 877 same checkpoint, single service
systemctl enable giorgio-revalidate
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 3
echo FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)
echo FINAL_ENABLED=$(systemctl is-enabled giorgio-revalidate)
PARENTS=$(pgrep -af 'production-revalidate-sanita-v3.mjs' | grep -v worker | grep -vc pgrep || true)
echo PARENT_LINES=$PARENTS
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
test ! -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf && echo NO_CANARY
echo DONE_ANGELA_FIX
