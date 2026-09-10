#!/bin/bash
# Restore Villa Dei Pini SELF_INSURANCE_VERIFIED with full evidence. Does NOT start 877.
set -euo pipefail
TID=cmqklex5q00bh108eq9blm01k
URL='https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf'
OUT=/opt/leadsniper-revalidate/data/revalidation
PDF=/tmp/PARM_2025_pini.pdf
RES="$OUT/results/${TID}.json"
CP="$OUT/checkpoint.json"

systemctl stop giorgio-revalidate 2>/dev/null || true

curl -fsSL -A 'Mozilla/5.0' -o "$PDF" "$URL"
SHA=$(sha256sum "$PDF" | awk '{print $1}')
SIZE=$(wc -c < "$PDF")
echo "PDF_SHA=$SHA SIZE=$SIZE"

# Extract text pages 7-8 (pdftotext 1-indexed)
PDFTXT=/tmp/parm_pini.txt
pdftotext -layout "$PDF" "$PDFTXT" 2>/dev/null || pdftotext "$PDF" "$PDFTXT"
# Also page-specific if available
pdftotext -f 7 -l 7 -layout "$PDF" /tmp/parm_p7.txt 2>/dev/null || true
pdftotext -f 8 -l 8 -layout "$PDF" /tmp/parm_p8.txt 2>/dev/null || true

python3 - <<'PY'
import json, re, hashlib
from pathlib import Path
from datetime import datetime, timezone

tid = "cmqklex5q00bh108eq9blm01k"
url = "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf"
pdf = Path("/tmp/PARM_2025_pini.pdf")
sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
p7 = Path("/tmp/parm_p7.txt").read_text(encoding="utf-8", errors="replace") if Path("/tmp/parm_p7.txt").exists() else ""
p8 = Path("/tmp/parm_p8.txt").read_text(encoding="utf-8", errors="replace") if Path("/tmp/parm_p8.txt").exists() else ""
full = Path("/tmp/parm_pini.txt").read_text(encoding="utf-8", errors="replace") if Path("/tmp/parm_pini.txt").exists() else (p7 + "\n" + p8)

# Find SI citation (page 7)
cite_re = re.compile(
    r"La\s+casa\s+di\s+cura\s+Villa\s+dei\s+Pini[\s\S]{0,220}?autoassicurazione\.?",
    re.IGNORECASE,
)
m = cite_re.search(p7) or cite_re.search(full)
if not m:
    # looser
    cite_re2 = re.compile(r".{0,80}autoassicurazione.{0,80}", re.IGNORECASE)
    m = cite_re2.search(p7) or cite_re2.search(full)
citation = " ".join((m.group(0) if m else "").split())
print("CITATION_FOUND", bool(m))
print("CITATION", citation[:300])

# Policy 2025 page 8
pol_n = None
comp = None
for text in (p8, full):
    m_n = re.search(r"0X000469|0x000469|n[°º.]?\s*0X000469", text, re.I)
    if m_n:
        pol_n = "0X000469"
    m_c = re.search(r"Revo\s*X?", text, re.I)
    if m_c:
        comp = m_c.group(0).strip()
        if re.search(r"Revo\s*X", text, re.I):
            comp = "Revo X"
print("POLICY_NUM", pol_n, "COMPANY", comp)

now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
if not citation:
    raise SystemExit("SI citation not found in PDF — abort restore")

evidence = (
    f"[V:PUB] [PS:SELF_INSURANCE_VERIFIED] [BV:SELF_INSURANCE_VERIFIED] "
    f"Autoassicurazione dichiarata — documento first-party PARM 2025, pagina 7. "
    f"Citazione: «{citation}». "
    f"Attribuzione: Villa Dei Pini Casa di Cura Privata S.p.a. "
    f"URL: {url} SHA256: {sha}. "
    f"Posizione assicurativa 2025 (pagina 8, evidence separata): "
    f"anno 2025; polizza n. {pol_n or 'n/d'}; compagnia {comp or 'n/d'}. "
    f"Scadenza: non indicata nel documento (non inventata)."
)

row = {
    "id": tid,
    "companyName": "Villa Dei Pini Casa di Cura Privata S.p.a.",
    "city": "Villamaina",
    "region": "Campania",
    "processingState": "SELF_INSURANCE_VERIFIED",
    "businessVerdict": "SELF_INSURANCE_VERIFIED",
    "newVerdict": "PUBLISHED",
    "reasonCode": "SELF_INSURANCE_VERIFIED",
    "publishedSubtype": "self_insurance",
    "policyCompany": "Autoassicurazione / gestione diretta del rischio",
    "policyNumber": None,
    "policyExpiry": None,  # do not invent
    "policyFound": True,
    "crawlComplete": True,
    "evidence": evidence,
    "evidenceUrls": [url],
    "sourcePdfUrl": url,
    "sourcePdfSha256": sha,
    "selfInsurance": {
        "declared": True,
        "page": 7,
        "citation": citation,
        "attribution": "Villa Dei Pini Casa di Cura Privata S.p.a.",
        "document": "PARM_2025.pdf",
        "url": url,
        "sha256": sha,
        "firstParty": True,
    },
    "insurancePosition2025": {
        "page": 8,
        "year": 2025,
        "policyNumber": pol_n,
        "company": comp,
        "expiry": None,
        "note": "posizione assicurativa separata; scadenza non presente nel documento",
        "url": url,
        "sha256": sha,
    },
    "completedAt": now,
    "finishedAt": now,
    "pass1": {
        "runId": "restore-si-pini-manual",
        "wallMs": 0,
        "error": None,
        "token": "PUBLISHED",
        "processingState": "SELF_INSURANCE_VERIFIED",
        "crawlComplete": True,
        "policyFound": True,
    },
}

out = Path("/opt/leadsniper-revalidate/data/revalidation/results")
out.mkdir(parents=True, exist_ok=True)
Path(f"{out}/{tid}.json").write_text(json.dumps(row, indent=2, ensure_ascii=False), encoding="utf-8")

cp_path = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(cp_path.read_text(encoding="utf-8"))
# normalize shapes
if not isinstance(cp.get("terminal"), dict):
    cp["terminal"] = {}
if not isinstance(cp.get("retryQueue"), dict):
    cp["retryQueue"] = {}
if not isinstance(cp.get("inProgress"), dict):
    cp["inProgress"] = {}
if not isinstance(cp.get("attempts"), dict):
    cp["attempts"] = {}
if not isinstance(cp.get("stats"), dict):
    cp["stats"] = {
        "processed": 0, "terminal": 0, "hot": 0, "pub": 0, "review": 0,
        "retry": 0, "tech": 0, "outOfScope": 0, "errors": 0,
    }

# remove from retry/inProgress
cp["retryQueue"].pop(tid, None)
cp["inProgress"].pop(tid, None)
cp["terminal"][tid] = {
    "finishedAt": now,
    "processingState": "SELF_INSURANCE_VERIFIED",
    "newVerdict": "PUBLISHED",
    "reasonCode": "SELF_INSURANCE_VERIFIED",
}
cp["attempts"][tid] = max(1, int(cp["attempts"].get(tid) or 0))
cp["updatedAt"] = now
cp_path.write_text(json.dumps(cp, indent=2), encoding="utf-8")

print("RESTORED")
print("PAGE", 7)
print("POLICY_2025", pol_n, comp)
print("SHA", sha)
print("terminal_n", len(cp["terminal"]))
print("FALSE_DEMOTION_REMOVED", True)
PY

# Ensure UI API sees it
curl -s "http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run" | python3 - <<'PY'
import sys,json
j=json.load(sys.stdin)
rows=j.get('results') or []
print('RUN_N', len(rows))
for r in rows:
  if 'Pini' in (r.get('companyName') or '') or r.get('id')=='cmqklex5q00bh108eq9blm01k':
    print('PINI', r.get('processingState') or r.get('publishedSubtype'), (r.get('evidence') or '')[:180])
PY

# corpus + db sha; leave paused
cd /opt/leadsniper
SHA=$(sha256sum prisma/dev.db | awk '{print $1}')
HC=$(python3 -c "import sqlite3;print(sqlite3.connect('prisma/dev.db').execute(\"select count(*) from Lead where type='HEALTHCARE'\").fetchone()[0])")
echo "DB_SHA=$SHA HC=$HC"
SCAN_ENGINE_LOCAL=1 DATABASE_URL="file:/opt/leadsniper/prisma/dev.db" npx tsx scripts/test-regression-corpus.mjs 2>&1 | tee /tmp/corpus-pini-restore.txt | tail -25
systemctl stop giorgio-revalidate 2>/dev/null || true
systemctl enable giorgio-revalidate
echo FINAL_ACTIVE=$(systemctl is-active giorgio-revalidate || true)
echo FINAL_ENABLED=$(systemctl is-enabled giorgio-revalidate)
