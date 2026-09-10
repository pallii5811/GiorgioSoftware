#!/usr/bin/env bash
set -euo pipefail
OUT=/tmp/stopship-forensic
IDS=$(cat "$OUT/tech-ids.txt")
python3 - <<'PY'
import json, sqlite3, re
from pathlib import Path

ids = Path("/tmp/stopship-forensic/tech-ids.txt").read_text().strip().splitlines()
res_dirs = [
    Path("/opt/leadsniper-revalidate/data/revalidation/results"),
    Path("/opt/leadsniper-revalidate/app/data/revalidation/results"),
]
cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
attempts = cp.get("attempts") or {}
conn = sqlite3.connect("/opt/leadsniper/prisma/dev.db")
conn.row_factory = sqlite3.Row

def load_result(lid):
    best = None
    path = None
    for d in res_dirs:
        for name in (f"{lid}.json", f"{lid}.p1.json", f"{lid}.p2.json"):
            p = d / name
            if p.exists():
                try:
                    j = json.loads(p.read_text(encoding="utf-8", errors="replace"))
                    if best is None or (j.get("finishedAt") or "") > (best.get("finishedAt") or ""):
                        best, path = j, str(p)
                except Exception:
                    pass
    return best, path

rows = []
matrix = {k: 0 for k in [
    "sito_errato","sito_offline","TLS","timeout","WAF_Cloudflare","browser_crash",
    "PDF_download","PDF_parser","OCR","identita","frontier","bug_worker",
    "limite_temporale","retry_non_ripreso","RETRY_EXHAUSTED","crawl_incomplete","altro"
]}

for lid in ids:
    lead = conn.execute(
        "SELECT id,companyName,website,city,region,evidence,policyFound,lastScannedAt FROM Lead WHERE id=?",
        (lid,),
    ).fetchone()
    res, rpath = load_result(lid)
    term = (cp.get("terminal") or {}).get(lid)
    ev = (res or {}).get("fullEvidence") or (lead["evidence"] if lead else "") or ""
    err = (res or {}).get("error")
    reason = (res or {}).get("reasonCode") or (term or {}).get("reasonCode")
    state = (res or {}).get("processingState") or (term or {}).get("processingState")
    wall = (res or {}).get("wallMs")
    crawl = (res or {}).get("crawlComplete")
    pages = (res or {}).get("pagesVisited")
    counters = (res or {}).get("counters") or {}
    website = (res or {}).get("website") or (lead["website"] if lead else None)
    reachable = (res or {}).get("websiteReachable")

    tags = []
    blob = json.dumps(res or {}, ensure_ascii=False) + "\n" + ev + "\n" + str(err)
    if reason and str(reason).startswith("RETRY_EXHAUSTED"):
        tags.append("RETRY_EXHAUSTED")
    if err and "LEAD_WALL_TIMEOUT" in str(err):
        tags.append("limite_temporale")
    if re.search(r"timeout|ETIMEDOUT|LEAD_WALL", blob, re.I):
        tags.append("timeout")
    if re.search(r"certificate|TLS|SSL|UNABLE_TO_VERIFY", blob, re.I):
        tags.append("TLS")
    if re.search(r"ENOTFOUND|ECONNREFUSED|getaddrinfo|DNS", blob, re.I):
        tags.append("sito_offline")
    if re.search(r"cloudflare|cf-ray|captcha|WAF", blob, re.I):
        tags.append("WAF_Cloudflare")
    if re.search(r"playwright|chromium|Target closed|browser", blob, re.I):
        tags.append("browser_crash")
    if re.search(r"PDF non processati|PDF_UNPROCESSED|pdf.?fail", blob, re.I):
        tags.append("PDF_download")
    if re.search(r"OCR_|tesseract|ocr", blob, re.I):
        tags.append("OCR")
    if re.search(r"IDENTITY|sito errato|Contaminazione|MISMATCH", blob, re.I):
        tags.append("identita")
    if re.search(r"FRONTIER|coda HTML|CRAWL_CAP|URL_CAP|sitemap|ROBOTS_REFERENCED_FAILED", blob, re.I):
        tags.append("frontier")
    if crawl is False or re.search(r"CRAWL_COMPLETE:false|FRONTIER_INCOMPLETE", blob, re.I):
        tags.append("crawl_incomplete")
    if not tags:
        tags.append("altro")
    for t in set(tags):
        matrix[t] = matrix.get(t, 0) + 1

    # phase guess
    phase = "unknown"
    if err and "LEAD_WALL_TIMEOUT" in str(err):
        phase = "wall_timeout_during_analyzeLead"
    elif reason == "PDF_UNPROCESSED":
        phase = "pdf_pipeline"
    elif reason == "FRONTIER_INCOMPLETE":
        phase = "frontier_incomplete"
    elif reason == "SITEMAP_UNRESOLVED":
        phase = "sitemap_unresolved"
    elif reason == "CRAWL_CAP":
        phase = "crawl_cap"
    elif reason and str(reason).startswith("RETRY_EXHAUSTED"):
        phase = "orchestrator_retry_exhausted"
    elif reachable is False:
        phase = "site_unreachable"

    http = sorted(set(re.findall(r"\b([45]\d\d)\b", blob)))
    urls = sorted(set(re.findall(r"https?://[^\s\"'<>\\]+", blob)))[:20]
    ocr = bool(re.search(r"OCR_|tesseract|\[OCR", blob, re.I))
    pdfs = sorted(set(re.findall(r"https?://[^\s\"'<>\\]+\.pdf[^\s\"'<>\\]*", blob, re.I)))[:15]

    missing = []
    if not crawl:
        missing.append("crawl completo / frontier esaurita su nodi rilevanti")
    if "PDF" in (reason or "") or "PDF non processati" in ev:
        missing.append("PDF download+parse+OCR pagina per pagina")
    if err:
        missing.append(f"risolvere errore worker: {err}")
    if attempts.get(lid, 0) >= 1 and str(reason or "").startswith("RETRY_EXHAUSTED"):
        missing.append("non dichiarare TECHNICAL_BLOCKED: restare in retry fino a esito commerciale")
    if not missing:
        missing.append("riesecuzione con budget maggiore e senza promote a TECHNICAL_BLOCKED")

    rows.append({
        "leadId": lid,
        "companyName": lead["companyName"] if lead else None,
        "website": website,
        "city": lead["city"] if lead else None,
        "region": lead["region"] if lead else None,
        "phaseFailed": phase,
        "reasonCode": reason,
        "processingState": state,
        "error": err,
        "wallMs": wall,
        "crawlComplete": crawl,
        "pagesVisited": pages,
        "websiteReachable": reachable,
        "attempts": attempts.get(lid),
        "httpCodes": http,
        "urlsSample": urls[:10],
        "pdfs": pdfs,
        "ocrAttempted": ocr,
        "resultPath": rpath,
        "terminalEntry": term,
        "pass1": (res or {}).get("pass1"),
        "counters": counters,
        "rootCauseTags": sorted(set(tags)),
        "missingForComplete": missing,
        "evidenceMarkers": sorted(set(re.findall(r"\[([A-Z0-9:_-]{3,40})\]", ev)))[:40],
    })

out = {
    "techCount": len(rows),
    "rootCauseMatrix": matrix,
    "primaryRootCause": "RETRY_EXHAUSTED→TECHNICAL_BLOCKED in production-revalidate-sanita-v3.mjs (orchestrator), not a true terminal commercial outcome",
    "leads": rows,
}
Path("/tmp/stopship-forensic/tech-forensic-v2.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"tech": len(rows), "matrix": matrix, "reasons": sorted({r.get('reasonCode') for r in rows})}, indent=2))
for r in rows:
    print(f"{r['leadId']}\t{r['reasonCode']}\t{r['phaseFailed']}\t{(r['companyName'] or '')[:40]}\tattempts={r['attempts']}\terr={r['error']}")
PY
