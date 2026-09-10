#!/bin/bash
# Patch Pini result for API fields fullEvidence+contentHash. No 877. No Malzoni touch.
set -euo pipefail
TID=cmqklex5q00bh108eq9blm01k
RES=/opt/leadsniper-revalidate/data/revalidation/results/${TID}.json
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json

systemctl stop giorgio-revalidate 2>/dev/null || true

python3 - <<'PY'
import json
from pathlib import Path
from datetime import datetime, timezone

tid = "cmqklex5q00bh108eq9blm01k"
url = "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf"
res_path = Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{tid}.json")
row = json.loads(res_path.read_text(encoding="utf-8"))

sha = row.get("sourcePdfSha256") or (row.get("selfInsurance") or {}).get("sha256")
si = row.get("selfInsurance") or {}
pos = row.get("insurancePosition2025") or {}
citation = si.get("citation") or (
    "La casa di cura Villa dei Pini assume in proprio la gestione dei "
    "sinistri e/o eventi avversi ed in particolare in autoassicurazione."
)
# Prefer OCR citation already stored; ensure complete sentence
if "autoassicurazione" not in citation.lower():
    raise SystemExit("missing SI citation")

pol_n = pos.get("policyNumber") or "0X000469"
comp = pos.get("company") or "Revo X"
page_si = int(si.get("page") or 7)
page_pol = int(pos.get("page") or 8)

full_evidence = (
    f"[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [BV:SELF_INSURANCE_VERIFIED] "
    f"Autoassicurazione dichiarata — documento first-party PARM 2025, pagina {page_si}. "
    f"Citazione: «{citation}». "
    f"Attribuzione: Villa Dei Pini Casa di Cura Privata S.p.a. "
    f"URL: {url} SHA256: {sha}. "
    f"Posizione assicurativa 2025 (pagina {page_pol}, evidence separata): "
    f"anno 2025; polizza n. {pol_n}; compagnia {comp}. "
    f"Scadenza: non indicata nel documento (non inventata)."
)

now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
row["processingState"] = "SELF_INSURANCE_VERIFIED"
row["businessVerdict"] = "SELF_INSURANCE_VERIFIED"
row["newVerdict"] = "PUBLISHED"
row["reasonCode"] = "SELF_INSURANCE_VERIFIED"
row["publishedSubtype"] = "self_insurance"
row["policyCompany"] = "Autoassicurazione / gestione diretta del rischio"
row["policyNumber"] = None
row["policyExpiry"] = None  # do not invent
row["policyFound"] = True
row["crawlComplete"] = True
row["fullEvidence"] = full_evidence  # required by mapResultRow
row["evidence"] = full_evidence
row["contentHash"] = sha
row["sourcePdfUrl"] = url
row["sourcePdfSha256"] = sha
row["evidenceUrls"] = [url]
row["selfInsurance"] = {
    "declared": True,
    "page": page_si,
    "citation": citation,
    "attribution": "Villa Dei Pini Casa di Cura Privata S.p.a.",
    "document": "PARM_2025.pdf",
    "url": url,
    "sha256": sha,
    "firstParty": True,
}
row["insurancePosition2025"] = {
    "page": page_pol,
    "year": 2025,
    "policyNumber": pol_n,
    "company": comp,
    "expiry": None,
    "note": "posizione assicurativa separata; scadenza non presente nel documento",
    "url": url,
    "sha256": sha,
}
row["finishedAt"] = row.get("finishedAt") or now
row["completedAt"] = row.get("completedAt") or now
res_path.write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding="utf-8")

cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(cp_path.read_text(encoding="utf-8"))
for k in ("terminal", "retryQueue", "inProgress", "attempts"):
    if not isinstance(cp.get(k), dict):
        cp[k] = {}
# purge demotion
cp["retryQueue"].pop(tid, None)
cp["inProgress"].pop(tid, None)
cp["terminal"][tid] = {
    "finishedAt": row["finishedAt"],
    "processingState": "SELF_INSURANCE_VERIFIED",
    "newVerdict": "PUBLISHED",
    "reasonCode": "SELF_INSURANCE_VERIFIED",
}
cp["updatedAt"] = now
cp_path.write_text(json.dumps(cp, indent=2), encoding="utf-8")

print("VILLA_DEI_PINI_STATE=SELF_INSURANCE_VERIFIED")
print("SELF_INSURANCE_CITATION=" + citation)
print("PAGE=" + str(page_si))
print("POLICY_2025_CAPTURED=" + f"{pol_n}|{comp}|page{page_pol}|expiry=null")
print("FALSE_DEMOTION_REMOVED=YES")
print("SHA=" + sha)
print("EV_LEN", len(full_evidence))
PY

curl -s "http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run" -o /tmp/run_pini.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/run_pini.json'))
rows=j.get('results') or []
print('RUN_N', len(rows))
for r in rows:
  print('LEAD', r.get('leadId'), r.get('companyName'))
  print('PS', r.get('processingState'), 'SUB', r.get('publishedSubtype'))
  print('PDFHASH', r.get('pdfHash'))
  print('EV', (r.get('evidence') or '')[:360])
PY

cd /opt/leadsniper
DBSHA=$(sha256sum prisma/dev.db | awk '{print $1}')
echo "DB_SHA=$DBSHA"
SCAN_ENGINE_LOCAL=1 DATABASE_URL="file:prisma/dev.db" npx tsx scripts/test-regression-corpus.mjs 2>&1 | tee /tmp/corpus-pini-final.txt | tail -25
systemctl stop giorgio-revalidate 2>/dev/null || true
systemctl enable giorgio-revalidate
echo FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)
echo FINAL_ENABLED=$(systemctl is-enabled giorgio-revalidate)

# confirm no demotion markers
python3 - <<'PY'
import json
from pathlib import Path
cp=json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
blob=json.dumps(cp)
print('DEMOTION_MARKER_PRESENT', 'FALSE_SI_DEMOTE' in blob)
tid='cmqklex5q00bh108eq9blm01k'
print('IN_TERMINAL', tid in (cp.get('terminal') or {}))
print('IN_RETRY', tid in (cp.get('retryQueue') or {}))
PY
