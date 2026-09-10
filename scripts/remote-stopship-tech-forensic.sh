#!/usr/bin/env bash
# Forensic dump for TECHNICAL_BLOCKED leads — read-only.
set -euo pipefail
OUT=/tmp/stopship-forensic
APP=/opt/leadsniper
REVAL=/opt/leadsniper-revalidate
CP="$REVAL/data/revalidation/checkpoint.json"
mkdir -p "$OUT"

python3 - <<'PY'
import json, os, sqlite3, re, glob, hashlib
from pathlib import Path

OUT = Path("/tmp/stopship-forensic")
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
c = json.loads(CP.read_text())
terminal = c.get("terminal") or {}
retry = c.get("retryQueue") or {}
inprog = c.get("inProgress") or {}

def ps(v):
    if isinstance(v, str):
        return v.upper()
    if not isinstance(v, dict):
        return ""
    return str(v.get("processingState") or v.get("state") or "").upper()

tech_ids = [k for k, v in terminal.items() if ps(v) == "TECHNICAL_BLOCKED"]

# DB lookup
db = "/opt/leadsniper/prisma/dev.db"
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# Prefer results files under revalidate
result_dirs = [
    Path("/opt/leadsniper-revalidate/data/revalidation/results"),
    Path("/opt/leadsniper-revalidate/app/data/revalidation/results"),
    Path("/opt/leadsniper-revalidate/data/results"),
    Path("/opt/leadsniper/data/revalidation/results"),
]

def find_result(lid):
    for d in result_dirs:
        if not d.exists():
            continue
        for p in d.rglob(f"*{lid}*"):
            if p.suffix in (".json", ".jsonl"):
                try:
                    return json.loads(p.read_text(encoding="utf-8", errors="replace")), str(p)
                except Exception:
                    pass
        # also try exact file
        for name in (f"{lid}.json", f"result-{lid}.json"):
            p = d / name
            if p.exists():
                try:
                    return json.loads(p.read_text(encoding="utf-8", errors="replace")), str(p)
                except Exception:
                    pass
    return None, None

# Scan worker logs for lead mentions
log_candidates = [
    "/var/log/syslog",
    "/opt/leadsniper-revalidate/app/data/revalidation/worker.log",
    "/opt/leadsniper-revalidate/data/revalidation/worker.log",
]
journal = ""
try:
    import subprocess
    journal = subprocess.check_output(
        ["journalctl", "-u", "giorgio-revalidate", "-n", "5000", "--no-pager"],
        text=True, errors="replace", timeout=30,
    )
except Exception as e:
    journal = f"<<journal unavailable: {e}>>"
(OUT / "journal-tail.txt").write_text(journal[-200000:], encoding="utf-8")

rows = []
matrix = {
    "sito_errato": 0,
    "sito_offline": 0,
    "TLS": 0,
    "timeout": 0,
    "WAF_Cloudflare": 0,
    "browser_crash": 0,
    "PDF_download": 0,
    "PDF_parser": 0,
    "OCR": 0,
    "identita": 0,
    "frontier": 0,
    "bug_worker": 0,
    "limite_temporale": 0,
    "retry_non_ripreso": 0,
    "altro": 0,
}

def classify(text: str):
    t = (text or "").lower()
    hits = []
    if re.search(r"cloudflare|cf-ray|attention required|access denied|waf|captcha", t):
        hits.append("WAF_Cloudflare")
    if re.search(r"econnrefused|enotfound|getaddrinfo|dns|nxdomain", t):
        hits.append("sito_offline" if "enotfound" in t or "dns" in t or "getaddrinfo" in t else "sito_offline")
    if re.search(r"certificate|tls|ssl|unable to verify|handshake", t):
        hits.append("TLS")
    if re.search(r"timeout|etimedout|aborted|deadline|time.?out", t):
        hits.append("timeout")
    if re.search(r"browser|playwright|chromium|target closed|page crashed", t):
        hits.append("browser_crash")
    if re.search(r"pdf.*(fail|error|download)|download.*pdf|pdf.?fetch", t):
        hits.append("PDF_download")
    if re.search(r"pdf.?pars|parse.?pdf|pdfjs|pdf-parse", t):
        hits.append("PDF_parser")
    if re.search(r"\bocr\b|tesseract", t):
        hits.append("OCR")
    if re.search(r"identit|attribution|wrong.?site|directory|non.?ufficial", t):
        hits.append("identita")
    if re.search(r"frontier|no.?more.?urls|crawl.?budget|exhausted.?frontier", t):
        hits.append("frontier")
    if re.search(r"time.?budget|max.?ms|deadline exceeded|scan.?budget", t):
        hits.append("limite_temporale")
    if re.search(r"retry|max.?attempt|attempts.?exhaust", t):
        hits.append("retry_non_ripreso")
    if not hits:
        hits.append("altro")
    return hits

for lid in tech_ids:
    cur.execute(
        "SELECT id, companyName, website, city, region, evidence, lastScannedAt, policyFound, notes FROM Lead WHERE id=?",
        (lid,),
    )
    lead = cur.fetchone()
    term = terminal.get(lid)
    res, res_path = find_result(lid)
    # extract journal lines
    jlines = [ln for ln in journal.splitlines() if lid in ln][-40:]
    blob = json.dumps(term, ensure_ascii=False) + "\n" + json.dumps(res, ensure_ascii=False)[:50000] + "\n" + "\n".join(jlines)
    # evidence snippets
    ev = (lead["evidence"] if lead else "") or ""
    # common markers
    http_codes = sorted(set(re.findall(r"\b([45]\d\d)\b", blob)))
    urls = sorted(set(re.findall(r"https?://[^\s\"'<>]+", blob)))[:40]
    ocr = bool(re.search(r"\bocr\b|tesseract|OCR_", blob + ev, re.I))
    attempts = None
    m = re.search(r"attempt[s]?[\"'=: ]+(\d+)", blob, re.I)
    if m:
        attempts = int(m.group(1))
    m2 = re.search(r"retryCount[\"'=: ]+(\d+)", blob, re.I)
    if m2:
        attempts = attempts or int(m2.group(1))

    reasons = []
    if isinstance(term, dict):
        for k in ("reason", "error", "lastError", "message", "detail", "blockReason", "technicalReason"):
            if term.get(k):
                reasons.append(f"{k}={term.get(k)}")
        # nested
        for k, v in term.items():
            if isinstance(v, (str, int, float)) and k not in ("processingState", "state"):
                if len(str(v)) < 300:
                    reasons.append(f"{k}={v}")

    hits = classify(blob + "\n" + ev)
    for h in hits:
        matrix[h] = matrix.get(h, 0) + 1

    row = {
        "leadId": lid,
        "companyName": lead["companyName"] if lead else None,
        "website": lead["website"] if lead else None,
        "city": lead["city"] if lead else None,
        "region": lead["region"] if lead else None,
        "terminalEntry": term,
        "resultPath": res_path,
        "resultKeys": list(res.keys()) if isinstance(res, dict) else None,
        "httpCodes": http_codes,
        "urlsSample": urls[:15],
        "ocrAttempted": ocr,
        "attemptsHint": attempts,
        "reasons": reasons[:20],
        "journalHits": len(jlines),
        "journalTail": jlines[-10:],
        "rootCauseTags": hits,
        "evidenceLen": len(ev),
        "evidenceHead": ev[:500],
        "inRetryQueue": lid in retry,
        "inProgress": lid in inprog,
        "missingForComplete": [],
    }
    # heuristic missing
    if not lead or not lead["website"]:
        row["missingForComplete"].append("sito ufficiale assente/da confermare")
    if "WAF_Cloudflare" in hits:
        row["missingForComplete"].append("bypass WAF / acquisizione browser stabile")
    if "timeout" in hits or "limite_temporale" in hits:
        row["missingForComplete"].append("budget tempo / retry prolungato")
    if "PDF_download" in hits or "PDF_parser" in hits or "OCR" in hits:
        row["missingForComplete"].append("pipeline PDF/OCR completa su documenti candidati")
    if "TLS" in hits:
        row["missingForComplete"].append("fetch TLS-tolerant / mirror ufficiale")
    if not row["missingForComplete"]:
        row["missingForComplete"].append("riesecuzione completa con resume frontier + blocco TECHNICAL come non-terminale")

    rows.append(row)

report = {
    "checkpoint": {
        "processed": (c.get("stats") or {}).get("processed"),
        "terminal": len(terminal),
        "tech": len(tech_ids),
        "inProgress": len(inprog),
        "retry": len(retry),
        "updatedAt": c.get("updatedAt"),
        "sha256": hashlib.sha256(CP.read_bytes()).hexdigest(),
    },
    "techCount": len(rows),
    "leads": rows,
    "rootCauseMatrix": matrix,
}
(OUT / "tech-forensic.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

# compact CSV-like summary
lines = ["leadId\tcompany\twebsite\ttags\thttp\tocr\tattempts"]
for r in rows:
    lines.append("\t".join([
        r["leadId"],
        (r["companyName"] or "")[:60],
        (r["website"] or "")[:60],
        ",".join(r["rootCauseTags"]),
        ",".join(r["httpCodes"]),
        str(r["ocrAttempted"]),
        str(r["attemptsHint"]),
    ]))
(OUT / "tech-summary.tsv").write_text("\n".join(lines), encoding="utf-8")
print(json.dumps({"tech": len(rows), "matrix": matrix, "out": str(OUT)}, indent=2))
# list result dirs existence
print("result_dirs", {str(d): d.exists() for d in result_dirs})
PY

echo FORENSIC_OK
ls -la "$OUT" | head -40
