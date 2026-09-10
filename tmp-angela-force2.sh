#!/bin/bash
set -euo pipefail
AID=cmqkld5s2009y108ejvgl7m92
PINI=cmqklex5q00bh108eq9blm01k
MALZ=cmqktyimz000i111hygme29nh
PDF=/tmp/amTrust.pdf
URL='https://villaangela.it/wp-content/uploads/2025/07/amTrust.pdf'
EVDIR=/opt/leadsniper-revalidate/data/revalidation/evidence-blobs
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json

systemctl stop giorgio-revalidate 2>/dev/null || true
rm -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf
systemctl daemon-reload

[[ -f "$PDF" ]] || curl -fsSL -A 'Mozilla/5.0' -o "$PDF" "$URL"
SHA=$(sha256sum "$PDF" | awk '{print $1}')
mkdir -p "$EVDIR"
cp -f "$PDF" "$EVDIR/${SHA}.pdf"
pdftotext -layout "$PDF" /tmp/amtrust_for_analyze.txt

# Analyze via UI tree (tsx resolves imports)
cd /opt/leadsniper
SCAN_ENGINE_LOCAL=1 npx tsx -e '
import fs from "node:fs";
import { analyzePolicy } from "./src/lib/sanita/detector.ts";
import { extractSchedaPolizzaFields } from "./src/lib/sanita/policy-scheda-extract.ts";
const text = fs.readFileSync("/tmp/amtrust_for_analyze.txt","utf8");
const scheda = extractSchedaPolizzaFields(text);
const a = analyzePolicy(text);
const ymd = (d)=> d ? d.toISOString().slice(0,10) : null;
const out = {
  schedaNumber: scheda.policyNumber,
  schedaExpiry: ymd(scheda.expiry),
  schedaQuietanza: ymd(scheda.nextPayment),
  analyzeNumber: a.policyNumber,
  analyzeExpiry: ymd(a.expiry),
  company: a.company,
  policyFound: a.policyFound,
};
if (out.analyzeExpiry !== "2025-12-31" || out.analyzeNumber !== "RCI00010002744") {
  console.error(out); process.exit(2);
}
if (out.schedaQuietanza === out.schedaExpiry) process.exit(3);
fs.writeFileSync("/tmp/angela_analyze.json", JSON.stringify(out,null,2));
console.log(JSON.stringify(out));
'

python3 - <<'PY'
import json, sqlite3, hashlib
from pathlib import Path
from datetime import datetime, timezone, date

aid="cmqkld5s2009y108ejvgl7m92"
pini="cmqklex5q00bh108eq9blm01k"
malz="cmqktyimz000i111hygme29nh"
url="https://villaangela.it/wp-content/uploads/2025/07/amTrust.pdf"
file_sha=hashlib.sha256(Path("/tmp/amTrust.pdf").read_bytes()).hexdigest()
an=json.loads(Path("/tmp/angela_analyze.json").read_text())
assert an["analyzeExpiry"]=="2025-12-31" and an["analyzeNumber"]=="RCI00010002744"
assert an["schedaQuietanza"]=="2025-06-30" and an["schedaQuietanza"]!=an["schedaExpiry"]
assert date.fromisoformat(an["analyzeExpiry"]) < date(2026,7,23)
ps="PUBLISHED_EXPIRED"
now=datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
c=sqlite3.connect("/opt/leadsniper/prisma/dev.db")
live=c.execute("select companyName,website,phone,email,pec,piva,category,city,region,status,notes from Lead where id=?",(aid,)).fetchone()
lm=dict(zip(["companyName","website","phone","email","pec","piva","category","city","region","crmStatus","notes"], live))
email=(lm.get("email") or "").lstrip("/")
full=(
  f"[V:PUB] [PS:{ps}] [BV:{ps}] Polizza RC certificata da PDF: {url} "
  f"AmTrust · n. {an['analyzeNumber']} · scadenza {an['analyzeExpiry']} "
  f"(Periodo di Assicurazione; Prossima quietanza {an['schedaQuietanza']} NON usata come expiry). "
  f"SHA256 file: {file_sha}."
)
row={
  "id": aid,
  "companyName": lm.get("companyName"),
  "city": lm.get("city"),
  "region": lm.get("region") or "Campania",
  "category": lm.get("category"),
  "website": lm.get("website"),
  "phone": lm.get("phone"),
  "email": email or None,
  "pec": lm.get("pec"),
  "piva": lm.get("piva"),
  "crmStatus": lm.get("crmStatus"),
  "notes": lm.get("notes"),
  "processingState": ps,
  "businessVerdict": ps,
  "newVerdict": "PUBLISHED",
  "reasonCode": ps,
  "publishedSubtype": "policy_expired",
  "policyCompany": an.get("company") or "AmTrust",
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
  "pass1": {"runId":"angela-scheda-fix","processingState":ps,"token":"PUBLISHED","policyFound":True,"crawlComplete":True,"error":None},
}
Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{aid}.json").write_text(json.dumps(row,indent=2,ensure_ascii=False),encoding="utf-8")
cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
for k in ("terminal","retryQueue","inProgress","attempts"):
  if not isinstance(cp.get(k), dict): cp[k]={}
assert cp["terminal"][pini]["processingState"]=="SELF_INSURANCE_VERIFIED"
assert cp["terminal"][malz]["processingState"]=="SELF_INSURANCE_VERIFIED"
cp["retryQueue"].pop(aid, None)
cp["inProgress"].pop(aid, None)
cp["terminal"][aid]={"finishedAt":now,"processingState":ps,"newVerdict":"PUBLISHED","reasonCode":ps}
cp["attempts"][aid]=max(1,int(cp["attempts"].get(aid) or 0)+1)
cp["updatedAt"]=now
Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").write_text(json.dumps(cp,indent=2),encoding="utf-8")
print("VILLA_ANGELA_STATE", ps)
print("POLICY_NUMBER", an["analyzeNumber"])
print("POLICY_EXPIRY", an["analyzeExpiry"])
print("NEXT_PAYMENT_NOT_USED_AS_EXPIRY", an["schedaQuietanza"])
print("TERMINAL_N", len(cp["terminal"]))
print("WEBSITE", row["website"])
print("PHONE", row["phone"])
print("EMAIL", row["email"])
print("PEC", row["pec"])
print("PIVA", row["piva"])
print("PINI", cp["terminal"][pini]["processingState"])
print("MALZ", cp["terminal"][malz]["processingState"])
PY

cd /opt/leadsniper
SCAN_ENGINE_LOCAL=1 DATABASE_URL="file:prisma/dev.db" npx tsx scripts/test-regression-corpus.mjs 2>&1 | tee /tmp/corpus-a3.txt | tail -12
SCAN_ENGINE_LOCAL=1 npx tsx scripts/test-scheda-polizza-extract.mjs 2>&1 | tee /tmp/scheda3.txt | tail -8
echo DB_SHA=$(sha256sum prisma/dev.db | awk '{print $1}')
curl -s 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run' -o /tmp/run_a3.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/run_a3.json'))
for r in j.get('results') or []:
  if 'Angela' in (r.get('companyName') or ''):
    print('API', r.get('publishedSubtype'), r.get('policyNumber'), r.get('policyExpiry'), r.get('website'), r.get('phone'), r.get('email'), (r.get('pdfHash') or '')[:16])
print('RUN_N', len(j.get('results') or []))
PY
curl -s -o /dev/null -w "evidence_http=%{http_code}\n" "http://127.0.0.1:3000/api/sanita/archive-revalidation/evidence-file?sha=$SHA"

systemctl enable giorgio-revalidate
systemctl reset-failed giorgio-revalidate || true
systemctl start giorgio-revalidate
sleep 4
echo FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)
echo FINAL_ENABLED=$(systemctl is-enabled giorgio-revalidate)
echo PARENTS=$(pgrep -af 'production-revalidate-sanita-v3.mjs' | grep -v worker | grep -vc pgrep || true)
grep APPLY_LIVE /etc/systemd/system/giorgio-revalidate.service.d/00-safety.conf
test ! -f /etc/systemd/system/giorgio-revalidate.service.d/canary.conf && echo NO_CANARY
echo DONE
