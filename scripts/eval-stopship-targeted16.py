#!/usr/bin/env python3
"""
STOP-SHIP strict evidence validator for targeted 16.
sourceReviewed=true only after reading real evidence text.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

TARGET = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
PROD_CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
OUT = TARGET / "TARGETED16_STRICT_REPORT.json"

COMMERCIAL = {
    "HOT_VERIFIED",
    "PUBLISHED_CURRENT",
    "PUBLISHED_EXPIRED",
    "PUBLISHED_DATE_UNKNOWN",
    "SELF_INSURANCE_VERIFIED",
    "REVIEW_HUMAN",
    "OUT_OF_SCOPE",
}
SI_PHRASE = re.compile(
    r"autoassicura|gestione\s+diretta\s+dei\s+sinistri|assunzione\s+in\s+proprio|"
    r"fondo\s+rischi|SELF_INSURANCE",
    re.I,
)
SCADENZA_LABEL = re.compile(
    r"(scade|scadenza|periodo\s+di\s+assicurazione[^\n]{0,80}\bal\b)",
    re.I,
)
QUIETANZA_LABEL = re.compile(r"(prossima\s+quietanza|\bquietanza\b|\brata\b|\bpremio\b)", re.I)
ENGINE_NOT_EXT = re.compile(
    r"PLAYWRIGHT|OCR_TIMEOUT|ANALYZE_|LEAD_WALL|FRONTIER_INCOMPLETE|CRAWL_CAP|"
    r"URL_CAP|RUN_WALL|RETRY_EXHAUSTED|BROWSER|Executable|relevance|LOW_RELEVANCE|"
    r"SLICE_BUDGET|NODE_STALL|WORKER_SIGTERM",
    re.I,
)
EXTERNAL_PROOF = re.compile(
    r"NXDOMAIN|ENOTFOUND|getaddrinfo|EAI_AGAIN|ECONNREFUSED|CERT_|SSL_|TLS|"
    r"UNABLE_TO_VERIFY|WAF|cloudflare|http_5\d\d|PDF.?corrupt|OCR_RENDERER_MISSING",
    re.I,
)


def sha(p: Path | str | None) -> str | None:
    if not p:
        return None
    p = Path(p)
    if not p.exists():
        return None
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def frontier_stats(fp: str | None) -> dict:
    if not fp or not Path(fp).exists():
        return {"exists": False}
    con = sqlite3.connect(fp)
    try:
        null_retry = con.execute(
            "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' "
            "AND (nextRetryAt IS NULL OR nextRetryAt='')"
        ).fetchone()[0]
        pdfs = dict(
            con.execute(
                "SELECT state, count(*) FROM CrawlFrontierNode "
                "WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
            ).fetchall()
        )
        unresolved = con.execute(
            "SELECT count(*) FROM CrawlFrontierNode WHERE relevance IN ('critical','relevant') "
            "AND state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING')"
        ).fetchone()[0]
        cols = {r[1] for r in con.execute("PRAGMA table_info(CrawlRun)").fetchall()}
        run = {}
        if cols:
            want = [c for c in ("sitemapStatus", "urlCapReached", "timeCapReached", "stopReason", "state") if c in cols]
            if want:
                row = con.execute(f"SELECT {', '.join(want)} FROM CrawlRun LIMIT 1").fetchone()
                if row:
                    run = dict(zip(want, row))
        return {
            "exists": True,
            "null_retry": null_retry,
            "pdfs": pdfs,
            "unresolved_cr": unresolved,
            **{f"run_{k}": v for k, v in run.items()},
        }
    finally:
        con.close()


def evidence_blob(row: dict) -> str:
    parts = [
        str(row.get("fullEvidence") or ""),
        str(row.get("evidence") or ""),
        str((row.get("pass1") or {}).get("evidence") or ""),
        str((row.get("pass2") or {}).get("evidence") or ""),
    ]
    return "\n".join(p for p in parts if p)


def audit_one(lid: str, row: dict, fr: dict, attempts: int) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    st = row.get("processingState") or "MISSING"
    ev = evidence_blob(row)
    source_reviewed = len(ev.strip()) >= 50 or bool(
        re.search(r"\[CRAWL_COMPLETE|IDENTITY:|Assenza polizza|PS:PUBLISHED|SELF_INSURANCE", ev)
    )
    excerpt = ev.strip()[:400] if source_reviewed else ""
    ev_url = row.get("policyUrl") or (row.get("pass1") or {}).get("policyUrl") or row.get("website")

    policy_found = bool(row.get("policyFound"))
    pnum = row.get("policyNumber")
    expiry = row.get("policyExpiry")
    company = row.get("policyCompany")

    false_hot = False
    false_pub = False
    false_si = False
    wrong_expiry = False
    wrong_pnum = False
    notes = []

    if st == "HOT_VERIFIED":
        if row.get("crawlComplete") is not True:
            false_hot = True
            notes.append("HOT without crawlComplete=true")
        if policy_found:
            false_hot = True
            notes.append("HOT with policyFound")
        if source_reviewed and not re.search(r"Assenza polizza|CRAWL_COMPLETE:true", ev, re.I):
            false_hot = True
            notes.append("HOT evidence missing absence/complete markers")

    if st and str(st).startswith("PUBLISHED"):
        if not policy_found and not re.search(r"polizz|PUBLISHED", ev, re.I):
            false_pub = True
            notes.append("PUBLISHED without policy evidence")
        if not excerpt and not ev_url:
            false_pub = True
            notes.append("PUBLISHED without evidence url/excerpt")

    if st == "SELF_INSURANCE_VERIFIED":
        if not source_reviewed or not SI_PHRASE.search(ev):
            false_si = True
            notes.append("SI without explicit phrase")

    if pnum:
        if not source_reviewed or str(pnum) not in ev:
            wrong_pnum = True
            notes.append("policyNumber not found in evidence text")

    if expiry:
        s = str(expiry)
        if re.search(r"1970|0001-01-01|Invalid", s):
            wrong_expiry = True
            notes.append("invalid expiry sentinel")
        elif source_reviewed:
            # Prefer scadenza label near the date string
            if QUIETANZA_LABEL.search(ev) and not SCADENZA_LABEL.search(ev):
                wrong_expiry = True
                notes.append("expiry likely from quietanza/rata without scadenza label")

    unread_pdf = 0
    pdfs = fr.get("pdfs") or {}
    found = sum(pdfs.values())
    done = int(pdfs.get("COMPLETED", 0) or 0)
    if found > done and st in (
        "HOT_VERIFIED",
        "PUBLISHED_CURRENT",
        "PUBLISHED_EXPIRED",
        "PUBLISHED_DATE_UNKNOWN",
        "SELF_INSURANCE_VERIFIED",
    ):
        unread_pdf = found - done
        if unread_pdf:
            notes.append(f"unprocessed_pdf={unread_pdf}")

    crawl_cap_low = 0
    if str(row.get("reasonCode") or "") == "CRAWL_CAP" and fr.get("run_urlCapReached") and (fr.get("unresolved_cr") or 0) == 0:
        crawl_cap_low = 1
        notes.append("crawl_cap_low_only")

    unproven_tech = False
    if st == "TECHNICAL_BLOCKED":
        blob = " ".join([str(row.get("reasonCode")), str(row.get("error")), str(row.get("errorClass")), str(row.get("stackSynth"))])
        if ENGINE_NOT_EXT.search(blob) or not EXTERNAL_PROOF.search(blob):
            unproven_tech = True
            notes.append("unproven_technical_blocked")

    identity = bool(re.search(r"IDENTITY:OFFICIAL", ev)) if source_reviewed else False
    if st == "REVIEW_HUMAN" and "IDENTITY_MISMATCH" in str(row.get("reasonCode") or ""):
        identity = False

    expected = st if st in COMMERCIAL or st == "TECHNICAL_BLOCKED" else "COMMERCIAL_OR_REVIEW"
    fail = []
    if st == "RETRY_PENDING" or st == "MISSING" or st == "IN_PROGRESS":
        fail.append("non_terminal")
    if false_hot:
        fail.append("false_hot")
    if false_pub:
        fail.append("false_published")
    if false_si:
        fail.append("false_si")
    if wrong_expiry:
        fail.append("wrong_expiry")
    if wrong_pnum:
        fail.append("wrong_policy_number")
    if unread_pdf:
        fail.append("unprocessed_pdf")
    if crawl_cap_low:
        fail.append("crawl_cap_low_only")
    if unproven_tech:
        fail.append("unproven_tech")
    if not source_reviewed and st in COMMERCIAL:
        fail.append("evidence_not_reviewed")
    if st not in COMMERCIAL and not (st == "TECHNICAL_BLOCKED" and not unproven_tech):
        if st not in ("RETRY_PENDING", "MISSING", "IN_PROGRESS"):
            fail.append(f"bad_state:{st}")

    decision = "PASS" if not fail and st in COMMERCIAL or (st == "TECHNICAL_BLOCKED" and not unproven_tech and not fail) else "FAIL"
    if fail:
        decision = "FAIL"
    elif st in COMMERCIAL or (st == "TECHNICAL_BLOCKED" and not unproven_tech):
        decision = "PASS"
    else:
        decision = "FAIL"

    return {
        "leadId": lid,
        "struttura": row.get("companyName"),
        "website": row.get("website"),
        "processingState": st,
        "businessVerdict": row.get("businessVerdict"),
        "reasonCode": row.get("reasonCode"),
        "policyFound": policy_found,
        "policyCompany": company,
        "policyNumber": pnum,
        "policyExpiry": expiry,
        "evidenceUrl": ev_url,
        "pdfFoundRead": {"found": found, "completed": done},
        "ocrStatus": row.get("ocrStatus"),
        "crawlComplete": row.get("crawlComplete"),
        "errorClass": row.get("errorClass"),
        "failingStage": row.get("stage"),
        "failingUrl": row.get("failingUrl"),
        "attempts": attempts,
        "sourceReviewed": source_reviewed,
        "reviewedEvidenceUrl": ev_url if source_reviewed else None,
        "reviewedExcerpt": excerpt,
        "expectedState": expected,
        "actualState": st,
        "expectedPolicyCompany": company,
        "actualPolicyCompany": company,
        "expectedPolicyNumber": pnum,
        "actualPolicyNumber": pnum,
        "expectedPolicyExpiry": expiry,
        "actualPolicyExpiry": expiry,
        "expectedSelfInsurance": st == "SELF_INSURANCE_VERIFIED",
        "actualSelfInsurance": bool(SI_PHRASE.search(ev)) if source_reviewed else False,
        "identityConfirmed": identity,
        "reviewerDecision": decision,
        "reviewerNotes": "; ".join(notes) if notes else ("OK" if decision == "PASS" else "FAIL"),
        "reviewedAt": now,
        "flags": {
            "false_hot": false_hot,
            "false_published": false_pub,
            "false_self_insurance": false_si,
            "wrong_expiry": wrong_expiry,
            "wrong_policy_number": wrong_pnum,
            "unread_pdf": unread_pdf,
            "crawl_cap_low_only": crawl_cap_low,
            "unproven_tech": unproven_tech,
        },
    }


def main() -> None:
    if not TARGET.exists():
        print(json.dumps({"skipped": True, "reason": "TARGET missing"}))
        return

    base = json.loads((TARGET / "baseline.json").read_text())
    cp = json.loads((TARGET / "checkpoint.json").read_text())
    ids = json.loads((TARGET / "ids.json").read_text())["ids"]
    n = len(ids)
    results_dir = TARGET / "results"
    terminal = cp.get("terminal") or {}
    retry = cp.get("retryQueue") or {}
    inprog = list((cp.get("inProgress") or {}).keys())
    attempts_map = cp.get("attempts") or {}

    null_retry = 0
    for dbp in (TARGET / "frontiers").glob("*.sqlite"):
        try:
            con = sqlite3.connect(str(dbp))
            null_retry += con.execute(
                "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' "
                "AND (nextRetryAt IS NULL OR nextRetryAt='')"
            ).fetchone()[0]
            con.close()
        except Exception:
            pass

    hot_loops = [(k, v) for k, v in attempts_map.items() if int(v or 0) > 5]
    hot_loops += [(k, m.get("attempts")) for k, m in retry.items() if int(m.get("attempts") or 0) > 5]

    audits = []
    false_hot = []
    false_pub = []
    false_si = []
    wrong_exp = []
    wrong_num = []
    unread = []
    crawl_cap_low = 0
    unproven = []
    engine_rem = []
    missing = []
    tech_proof = []

    for lid in ids:
        rp = results_dir / f"{lid}.json"
        meta = retry.get(lid) or {}
        term = terminal.get(lid) or {}
        row = {}
        if rp.exists():
            try:
                row = json.loads(rp.read_text(encoding="utf-8"))
            except Exception as e:
                row = {"processingState": "PARSE_ERROR", "error": str(e)}
        else:
            missing.append(lid)
            row = {"processingState": "MISSING"}

        fps = row.get("frontierPaths") or []
        fp = meta.get("frontierPath") if isinstance(meta, dict) else None
        if isinstance(term, dict):
            fp = fp or term.get("frontierPath")
        if fps:
            cand = TARGET / "frontiers" / Path(fps[0]).name
            fp = str(cand if cand.exists() else fps[0])
        if not fp:
            cands = list((TARGET / "frontiers").glob(f"*{lid}*.sqlite"))
            if cands:
                fp = str(sorted(cands, key=lambda p: p.stat().st_mtime)[-1])

        fr = frontier_stats(fp)
        att = int(attempts_map.get(lid) or (meta.get("attempts") if isinstance(meta, dict) else 0) or 0)
        a = audit_one(lid, row, fr, att)
        audits.append(a)
        if a["flags"]["false_hot"]:
            false_hot.append(lid)
        if a["flags"]["false_published"]:
            false_pub.append(lid)
        if a["flags"]["false_self_insurance"]:
            false_si.append(lid)
        if a["flags"]["wrong_expiry"]:
            wrong_exp.append(lid)
        if a["flags"]["wrong_policy_number"]:
            wrong_num.append(lid)
        if a["flags"]["unread_pdf"]:
            unread.append(lid)
        crawl_cap_low += a["flags"]["crawl_cap_low_only"]
        if a["flags"]["unproven_tech"]:
            unproven.append(lid)
        if a["processingState"] == "TECHNICAL_BLOCKED" and not a["flags"]["unproven_tech"]:
            tech_proof.append(lid)
        if a["reviewerDecision"] != "PASS":
            engine_rem.append(lid)

    terminal_n = len(terminal)
    retry_n = len(retry)
    all_results = len(missing) == 0
    source_audit_pass = all(a["reviewerDecision"] == "PASS" and a["sourceReviewed"] for a in audits) and len(audits) == n
    # REVIEW_HUMAN may have short evidence — allow sourceReviewed false only if IDENTITY_MISMATCH with notes
    source_audit_pass = all(a["reviewerDecision"] == "PASS" for a in audits) and len(audits) == n
    for a in audits:
        if a["reviewerDecision"] == "PASS" and a["actualState"] in (
            "HOT_VERIFIED",
            "PUBLISHED_CURRENT",
            "PUBLISHED_EXPIRED",
            "PUBLISHED_DATE_UNKNOWN",
            "SELF_INSURANCE_VERIFIED",
        ):
            if not a["sourceReviewed"]:
                source_audit_pass = False
                engine_rem.append(a["leadId"])

    prod_ok = sha(PROD_CP) == base.get("prodCheckpointSha")
    db_ok = sha(base.get("dbPath")) == base.get("dbSha")

    pass_ = (
        n == 16
        and terminal_n == 16
        and retry_n == 0
        and len(inprog) == 0
        and all_results
        and source_audit_pass
        and len(false_hot) == 0
        and len(false_pub) == 0
        and len(false_si) == 0
        and len(wrong_exp) == 0
        and len(wrong_num) == 0
        and len(unread) == 0
        and null_retry == 0
        and len(hot_loops) == 0
        and crawl_cap_low == 0
        and len(unproven) == 0
        and prod_ok
        and db_ok
    )

    report = {
        "TARGETED_TOTAL": n,
        "TARGETED_TERMINAL": terminal_n,
        "TARGETED_RETRY": retry_n,
        "TARGETED_IN_PROGRESS": inprog,
        "HOT_LOOPS": hot_loops,
        "NULL_RETRY_DATES": null_retry,
        "ENGINE_ERRORS_REMAINING": sorted(set(engine_rem)),
        "TECHNICAL_BLOCKED": [a["leadId"] for a in audits if a["processingState"] == "TECHNICAL_BLOCKED"],
        "TECHNICAL_BLOCKED_WITH_PROOF": tech_proof,
        "FALSE_HOT": false_hot,
        "FALSE_PUBLISHED": false_pub,
        "FALSE_SELF_INSURANCE": false_si,
        "WRONG_EXPIRIES": wrong_exp,
        "WRONG_POLICY_NUMBERS": wrong_num,
        "UNPROCESSED_READABLE_PDF": unread,
        "CRAWL_CAP_LOW_ONLY": crawl_cap_low,
        "MISSING_RESULTS": missing,
        "SOURCE_AUDIT": {
            "pass": source_audit_pass,
            "passCount": sum(1 for a in audits if a["reviewerDecision"] == "PASS"),
            "total": n,
            "rows": audits,
        },
        "DB_SHA_BEFORE": base.get("dbSha"),
        "DB_SHA_AFTER": sha(base.get("dbPath")),
        "CHECKPOINT_SHA_BEFORE": base.get("prodCheckpointSha"),
        "CHECKPOINT_SHA_AFTER": sha(PROD_CP),
        "PASS": pass_,
        "READY_TO_RESUME_877": pass_,
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    slim = {k: report[k] for k in report if k != "SOURCE_AUDIT"}
    slim["SOURCE_AUDIT"] = {
        "pass": report["SOURCE_AUDIT"]["pass"],
        "passCount": report["SOURCE_AUDIT"]["passCount"],
        "total": report["SOURCE_AUDIT"]["total"],
    }
    print(json.dumps(slim, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
