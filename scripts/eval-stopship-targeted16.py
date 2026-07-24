#!/usr/bin/env python3
"""
STOP-SHIP validator for isolated targeted retry rerun (16 leads).

PASS only if terminal_n === N, retry_n === 0, inProgress === 0, and all
strict gates below. reachable_done >= 15 is NOT a valid criterion.
Never auto-PASS TECHNICAL_BLOCKED without documented external proof.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import Counter
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

# Engine failures that must NEVER be accepted as TECHNICAL_BLOCKED proof
ENGINE_NOT_EXTERNAL = re.compile(
    r"PLAYWRIGHT|OCR_TIMEOUT|ANALYZE_|LEAD_WALL|FRONTIER_INCOMPLETE|CRAWL_CAP|"
    r"URL_CAP|RUN_WALL|RETRY_EXHAUSTED|BROWSER|Executable doesn't exist|"
    r"relevance|LOW_RELEVANCE|SLICE_BUDGET|NODE_STALL",
    re.I,
)

EXTERNAL_PROOF = re.compile(
    r"NXDOMAIN|ENOTFOUND|getaddrinfo|EAI_AGAIN|host.?unreachable|"
    r"CERT_|SSL_|TLS|UNABLE_TO_VERIFY|WAF|cloudflare.?challenge|"
    r"http_5\d\d|PDF.?corrupt|OCR_RENDERER_MISSING|ECONNREFUSED",
    re.I,
)


def sha(p: Path | str | None) -> str | None:
    if not p:
        return None
    p = Path(p)
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def frontier_stats(fp: str | None) -> dict:
    if not fp or not Path(fp).exists():
        return {"exists": False}
    con = sqlite3.connect(fp)
    try:
        null_retry = con.execute(
            "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' "
            "AND (nextRetryAt IS NULL OR nextRetryAt='')"
        ).fetchone()[0]
        pdfs = con.execute(
            "SELECT state, count(*) FROM CrawlFrontierNode "
            "WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
        ).fetchall()
        unresolved = con.execute(
            "SELECT count(*) FROM CrawlFrontierNode "
            "WHERE relevance IN ('critical','relevant') "
            "AND state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING')"
        ).fetchone()[0]
        run = con.execute(
            "SELECT sitemapStatus, urlCapReached, timeCapReached, state, stopReason FROM CrawlRun LIMIT 1"
        ).fetchone()
        return {
            "exists": True,
            "null_retry": null_retry,
            "pdfs": {s: c for s, c in pdfs},
            "unresolved_cr": unresolved,
            "sitemapStatus": run[0] if run else None,
            "urlCapReached": bool(run[1]) if run else False,
            "timeCapReached": bool(run[2]) if run else False,
            "runState": run[3] if run else None,
            "stopReason": run[4] if run else None,
        }
    finally:
        con.close()


def audit_row(lid: str, row: dict, fr: dict, attempts: int) -> dict:
    st = row.get("processingState") or "?"
    reason = str(row.get("reasonCode") or row.get("error") or "")
    err_class = row.get("errorClass")
    policy_found = row.get("policyFound")
    expiry = row.get("policyExpiry")
    pnum = row.get("policyNumber")
    crawl_complete = bool(row.get("crawlComplete"))
    token = row.get("token") or row.get("newVerdict")

    false_hot = st == "HOT_VERIFIED" and crawl_complete is False
    false_pub = bool(st and str(st).startswith("PUBLISHED") and not policy_found and not row.get("fullEvidence"))
    # self-insurance false: stamped SI but evidence lacks self-insurance citation
    ev = str(row.get("fullEvidence") or "")
    false_si = st == "SELF_INSURANCE_VERIFIED" and not re.search(
        r"autoassicura|self.?insur|fondo.?rischi|SELF_INSURANCE", ev, re.I
    )

    wrong_expiry = False
    if expiry and re.search(r"1970|0001-01-01|Invalid", str(expiry)):
        wrong_expiry = True

    unread_pdf = 0
    pdfs = fr.get("pdfs") or {}
    found = sum(pdfs.values())
    done = pdfs.get("COMPLETED", 0)
    if found > done and st in COMMERCIAL and "PDF_UNPROCESSED" not in reason:
        # commercial terminal while PDFs left unread — flag
        unread_pdf = found - done

    crawl_cap_low_only = 0
    if reason == "CRAWL_CAP" and fr.get("urlCapReached") and (fr.get("unresolved_cr") or 0) == 0:
        crawl_cap_low_only = 1

    unproven_tech = False
    if st == "TECHNICAL_BLOCKED":
        proof_blob = " ".join(
            [
                reason,
                str(row.get("error") or ""),
                str(err_class or ""),
                str(row.get("stackSynth") or ""),
            ]
        )
        if ENGINE_NOT_EXTERNAL.search(proof_blob) or not EXTERNAL_PROOF.search(proof_blob):
            unproven_tech = True

    # final classification
    if st in ("HOT_VERIFIED", "PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN", "SELF_INSURANCE_VERIFIED"):
        final_cls = "COMMERCIAL_TERMINAL"
    elif st == "REVIEW_HUMAN":
        final_cls = "REVIEW_HUMAN"
    elif st == "TECHNICAL_BLOCKED" and not unproven_tech:
        final_cls = "EXTERNAL_PROVEN"
    elif st == "TECHNICAL_BLOCKED":
        final_cls = "ENGINE_FIXED"  # mislabeled — still engine
        unproven_tech = True
    elif st == "RETRY_PENDING":
        final_cls = "ENGINE_FIXED"
    else:
        final_cls = "ENGINE_FIXED"

    fail_reasons = []
    if st == "RETRY_PENDING":
        fail_reasons.append("still_retry")
    if false_hot:
        fail_reasons.append("false_hot")
    if false_pub:
        fail_reasons.append("false_published")
    if false_si:
        fail_reasons.append("false_self_insurance")
    if wrong_expiry:
        fail_reasons.append("wrong_expiry")
    if unread_pdf > 0:
        fail_reasons.append("unprocessed_readable_pdf")
    if crawl_cap_low_only:
        fail_reasons.append("crawl_cap_low_only")
    if unproven_tech:
        fail_reasons.append("unproven_technical_blocked")
    if st not in COMMERCIAL and st != "TECHNICAL_BLOCKED":
        fail_reasons.append(f"non_terminal:{st}")
    if st == "TECHNICAL_BLOCKED" and unproven_tech:
        fail_reasons.append("tech_blocked_not_external")

    audit_pass = len(fail_reasons) == 0 and (
        st in COMMERCIAL or (st == "TECHNICAL_BLOCKED" and not unproven_tech)
    )

    return {
        "leadId": lid,
        "struttura": row.get("companyName"),
        "website": row.get("website"),
        "processingState": st,
        "businessVerdict": row.get("businessVerdict"),
        "reasonCode": reason,
        "policyFound": policy_found,
        "policyCompany": row.get("policyCompany"),
        "policyNumber": pnum,
        "policyExpiry": expiry,
        "evidenceUrl": row.get("policyUrl") or (row.get("pass1") or {}).get("policyUrl"),
        "pdfFoundRead": {"found": found, "completed": done},
        "ocrStatus": row.get("ocrStatus"),
        "crawlComplete": crawl_complete,
        "sitemapStatus": fr.get("sitemapStatus"),
        "unresolvedCriticalRelevant": fr.get("unresolved_cr"),
        "errorClass": err_class,
        "failingStage": row.get("stage"),
        "failingUrl": row.get("failingUrl"),
        "attempts": attempts,
        "finalClass": final_cls,
        "auditPASS": audit_pass,
        "auditMotivation": "OK" if audit_pass else ";".join(fail_reasons),
        "flags": {
            "false_hot": false_hot,
            "false_published": false_pub,
            "false_self_insurance": false_si,
            "wrong_expiry": wrong_expiry,
            "unread_pdf": unread_pdf,
            "crawl_cap_low_only": crawl_cap_low_only,
            "unproven_tech": unproven_tech,
        },
    }


def main() -> None:
    base = json.loads((TARGET / "baseline.json").read_text())
    cp = json.loads((TARGET / "checkpoint.json").read_text())
    ids = json.loads((TARGET / "ids.json").read_text())["ids"]
    results_dir = TARGET / "results"
    n = len(ids)

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

    hot_loops = []
    for lid, a in attempts_map.items():
        if int(a or 0) > 5:
            hot_loops.append((lid, a))
    for lid, m in retry.items():
        if int(m.get("attempts") or 0) > 5:
            hot_loops.append((lid, m.get("attempts")))

    audits = []
    false_terminals = []
    wrong_expiries = []
    wrong_policy_numbers = []
    unread_pdfs = []
    crawl_cap_low = 0
    unproven_tech = []
    engine_remaining = []
    tech_with_proof = []
    missing_results = []

    for lid in ids:
        rp = results_dir / f"{lid}.json"
        meta = retry.get(lid) or {}
        term = terminal.get(lid) or {}
        fp = meta.get("frontierPath") or (term.get("frontierPath") if isinstance(term, dict) else None)
        # prefer inProgress / result frontierPaths
        row = {}
        if rp.exists():
            try:
                row = json.loads(rp.read_text(encoding="utf-8"))
            except Exception as e:
                row = {"processingState": "PARSE_ERROR", "error": str(e)}
            fps = row.get("frontierPaths") or []
            if fps:
                # use isolated copy if present
                name = Path(fps[0]).name
                cand = TARGET / "frontiers" / name
                fp = str(cand if cand.exists() else fps[0])
        else:
            missing_results.append(lid)
            row = {"processingState": "MISSING"}

        fr = frontier_stats(fp)
        att = int(attempts_map.get(lid) or meta.get("attempts") or 0)
        a = audit_row(lid, row, fr, att)
        audits.append(a)
        if a["flags"]["false_hot"] or a["flags"]["false_published"] or a["flags"]["false_self_insurance"]:
            false_terminals.append(lid)
        if a["flags"]["wrong_expiry"]:
            wrong_expiries.append(lid)
        if a["flags"]["unread_pdf"]:
            unread_pdfs.append(lid)
        crawl_cap_low += a["flags"]["crawl_cap_low_only"]
        if a["flags"]["unproven_tech"]:
            unproven_tech.append(lid)
        if a["processingState"] == "TECHNICAL_BLOCKED" and not a["flags"]["unproven_tech"]:
            tech_with_proof.append(lid)
        if not a["auditPASS"]:
            engine_remaining.append(lid)

    terminal_n = len(terminal)
    retry_n = len(retry)
    all_results = len(missing_results) == 0
    manual_audit_pass = all(a["auditPASS"] for a in audits) and len(audits) == n

    prod_ok = sha(PROD_CP) == base.get("prodCheckpointSha")
    db_ok = sha(base.get("dbPath")) == base.get("dbSha")

    pass_ = (
        terminal_n == n
        and retry_n == 0
        and len(inprog) == 0
        and all_results
        and null_retry == 0
        and len(hot_loops) == 0
        and len(false_terminals) == 0
        and len(wrong_expiries) == 0
        and len(wrong_policy_numbers) == 0
        and len(unread_pdfs) == 0
        and crawl_cap_low == 0
        and len(unproven_tech) == 0
        and manual_audit_pass
        and prod_ok
        and db_ok
    )

    report = {
        "PATCH_NOTE": "strict targeted16 validator — no reachable_done>=15 shortcut",
        "TARGETED_TOTAL": n,
        "TARGETED_TERMINAL": terminal_n,
        "TARGETED_RETRY": retry_n,
        "TARGETED_IN_PROGRESS": inprog,
        "HOT_LOOPS": hot_loops,
        "NULL_RETRY_DATES": null_retry,
        "ENGINE_ERRORS_REMAINING": engine_remaining,
        "TECHNICAL_BLOCKED": [a["leadId"] for a in audits if a["processingState"] == "TECHNICAL_BLOCKED"],
        "TECHNICAL_BLOCKED_WITH_PROOF": tech_with_proof,
        "FALSE_TERMINALS": false_terminals,
        "WRONG_EXPIRIES": wrong_expiries,
        "WRONG_POLICY_NUMBERS": wrong_policy_numbers,
        "UNPROCESSED_READABLE_PDF": unread_pdfs,
        "CRAWL_CAP_LOW_ONLY": crawl_cap_low,
        "MISSING_RESULTS": missing_results,
        "MANUAL_AUDIT": {
            "pass": manual_audit_pass,
            "passCount": sum(1 for a in audits if a["auditPASS"]),
            "total": n,
            "rows": audits,
        },
        "DB_SHA_BEFORE": base.get("dbSha"),
        "DB_SHA_AFTER": sha(base.get("dbPath")),
        "CHECKPOINT_SHA_BEFORE": base.get("prodCheckpointSha"),
        "CHECKPOINT_SHA_AFTER": sha(PROD_CP),
        "PASS": pass_,
        "READY_TO_RESUME_877": pass_,
        "gates": {
            "terminal_eq_n": terminal_n == n,
            "retry_eq_0": retry_n == 0,
            "in_progress_eq_0": len(inprog) == 0,
            "all_results": all_results,
            "null_retry_0": null_retry == 0,
            "hot_loops_0": len(hot_loops) == 0,
            "false_terminals_0": len(false_terminals) == 0,
            "wrong_expiries_0": len(wrong_expiries) == 0,
            "unread_pdf_0": len(unread_pdfs) == 0,
            "crawl_cap_low_0": crawl_cap_low == 0,
            "unproven_tech_0": len(unproven_tech) == 0,
            "manual_audit": manual_audit_pass,
            "prod_cp": prod_ok,
            "prod_db": db_ok,
        },
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    slim = {k: report[k] for k in report if k != "MANUAL_AUDIT"}
    slim["MANUAL_AUDIT"] = {
        "pass": report["MANUAL_AUDIT"]["pass"],
        "passCount": report["MANUAL_AUDIT"]["passCount"],
        "total": report["MANUAL_AUDIT"]["total"],
    }
    print(json.dumps(slim, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
