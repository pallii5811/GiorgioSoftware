#!/usr/bin/env python3
"""Enrich matrix with result evidence + classify root causes; write DIAGNOSIS.json."""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

MATRIX = Path("/opt/leadsniper-revalidate/data/stopship-retry11/RETRY11_MATRIX.json")
RESULTS = Path("/opt/leadsniper-revalidate/data/revalidation/results")
OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11/RETRY11_DIAGNOSIS.json")


def classify(item: dict, row: dict) -> dict:
    reason = str(item.get("lastReason") or "")
    err = str(item.get("lastError") or row.get("error") or "")
    evidence = str(row.get("fullEvidence") or "")
    fr = item.get("frontier") or {}
    run = fr.get("run") or {}
    mid = fr.get("fetched_parsed_mid") or []
    pdfs = fr.get("pdfs") or []
    retry_nodes = fr.get("retry_pending") or []
    blocked = fr.get("technical_blocked") or []
    unresolved = fr.get("unresolved_critical_relevant")
    wall = item.get("lastAttemptWallMs") or row.get("wallMs")

    # signals
    wall_hit = bool(re.search(r"LEAD_WALL_TIMEOUT", err)) or (
        isinstance(wall, (int, float)) and wall >= 3_200_000
    )
    pdf_unproc = "PDF_UNPROCESSED" in reason or bool(re.search(r"PDF non processati", evidence, re.I))
    crawl_cap = reason == "CRAWL_CAP" or bool(re.search(r"cap URL|URL_CAP|RUN_WALL_CLOCK", evidence, re.I))
    sitemap = reason == "SITEMAP_UNRESOLVED" or bool(
        re.search(r"ROBOTS_REFERENCED_FAILED|DISCOVERED_FAILED|SITEMAP", evidence + reason, re.I)
    )
    frontier_inc = reason == "FRONTIER_INCOMPLETE"
    identity = bool(re.search(r"IDENTITY:MISMATCH|sito errato|Contaminazione", evidence, re.I))
    dns = any(re.search(r"ENOTFOUND|NXDOMAIN|getaddrinfo|EAI_AGAIN", str(x.get("lastError") or ""), re.I) for x in blocked + retry_nodes)
    tls = any(re.search(r"CERT_|SSL_|TLS|UNABLE_TO_VERIFY", str(x.get("lastError") or ""), re.I) for x in blocked + retry_nodes)
    waf = any(re.search(r"403|challenge|cloudflare|captcha|waf", str(x.get("lastError") or "") + str(x.get("httpStatus") or ""), re.I) for x in blocked + retry_nodes)
    fetched_stuck = len(mid) > 0
    pdf_fetched_incomplete = [
        p for p in pdfs if p.get("state") in ("FETCHED", "PARSED", "FETCHING", "RETRY_PENDING")
    ]
    ocr_fail = any(
        re.search(r"OCR_|pdftoppm|tesseract", str(p.get("lastError") or ""), re.I) for p in pdfs + blocked + retry_nodes
    )
    url_cap = bool(run.get("urlCapReached"))
    time_cap = bool(run.get("timeCapReached"))
    low_only_pending = False
    # heartbeat
    hb = run.get("heartbeatNote") or run.get("lastHeartbeatAt")

    # Class decision
    cls = "A"
    root = []
    if identity:
        cls = "D"
        root.append("IDENTITY_MISMATCH_SIGNAL")
    elif dns and unresolved == 0 and not pdfs:
        cls = "C"
        root.append("DNS_OR_HOST_UNREACHABLE")
    elif tls and unresolved == 0:
        cls = "C"
        root.append("TLS_FAILURE")
    elif waf and unresolved == 0 and not any(p.get("state") == "COMPLETED" for p in pdfs):
        cls = "C"
        root.append("WAF_OR_403_TOTAL")
    elif wall_hit:
        cls = "A"
        root.append("LEAD_WALL_TIMEOUT_OPAQUE_AS_ANALYZE_ERROR")
        if url_cap:
            root.append("URL_CAP_SET")
        if time_cap:
            root.append("TIME_CAP_SET")
        if pdf_fetched_incomplete:
            root.append("PDF_FETCHED_INCOMPLETE")
        if fetched_stuck:
            root.append("NODES_STUCK_FETCHED_PARSED")
    elif pdf_unproc or pdf_fetched_incomplete:
        cls = "A"
        root.append("PDF_PIPELINE_INCOMPLETE")
        if ocr_fail:
            root.append("OCR_ERROR")
    elif crawl_cap and url_cap:
        cls = "A"
        root.append("CRAWL_CAP_URLCAP_POSSIBLY_LOW_FLOOD")
    elif crawl_cap and time_cap:
        cls = "B"
        root.append("TIME_CAP_EXTERNAL_SLOW_SITE")
    elif sitemap:
        # often engine treating unresolved sitemap as hard block incorrectly
        cls = "A"
        root.append("SITEMAP_BLOCKS_OR_MISCLASSIFIED")
    elif frontier_inc:
        cls = "A"
        root.append("FRONTIER_INCOMPLETE_CRITICAL_RELEVANT_LEFT")
        if unresolved:
            root.append(f"UNRESOLVED_CR={unresolved}")
    elif reason == "ANALYZE_ERROR_OR_TIMEOUT":
        cls = "A"
        root.append("OPAQUE_ANALYZE_ERROR")
        if err:
            root.append(f"ERR={err[:120]}")
        if not evidence:
            root.append("EMPTY_EVIDENCE_AFTER_ANALYZE")
    elif reason == "RETRY_PENDING":
        cls = "A"
        root.append("GENERIC_RETRY_PENDING_NO_CLASS")
    else:
        cls = "B"
        root.append(f"OTHER:{reason}")

    return {
        "class": cls,
        "rootCauses": root,
        "signals": {
            "wall_hit": wall_hit,
            "wallMs": wall,
            "pdf_unproc": pdf_unproc,
            "crawl_cap": crawl_cap,
            "sitemap": sitemap,
            "frontier_inc": frontier_inc,
            "identity": identity,
            "dns": dns,
            "tls": tls,
            "waf": waf,
            "fetched_stuck_n": len(mid),
            "pdf_incomplete_n": len(pdf_fetched_incomplete),
            "pdf_found": fr.get("pdf_found"),
            "pdf_completed": fr.get("pdf_completed"),
            "urlCapReached": url_cap,
            "timeCapReached": time_cap,
            "unresolved_cr": unresolved,
            "null_retry_next": fr.get("null_retry_next"),
            "sitemapStatus": run.get("sitemapStatus"),
            "heartbeat": hb,
            "error_raw": err[:300] if err else None,
            "evidence_head": evidence[:400] if evidence else None,
        },
    }


def main() -> None:
    report = json.loads(MATRIX.read_text(encoding="utf-8"))
    enriched = []
    by_class = Counter()
    for item in report["matrix"]:
        lid = item["leadId"]
        row = {}
        rp = RESULTS / f"{lid}.json"
        if rp.exists():
            try:
                row = json.loads(rp.read_text(encoding="utf-8"))
            except Exception as e:
                row = {"parseError": str(e)}
        # company from result if missing
        if not item.get("companyName"):
            item["companyName"] = row.get("companyName")
        if not item.get("website"):
            item["website"] = row.get("website")
        diag = classify(item, row)
        by_class[diag["class"]] += 1
        enriched.append(
            {
                "leadId": lid,
                "companyName": item.get("companyName"),
                "website": item.get("website"),
                "attempts": item.get("attempts"),
                "lastReason": item.get("lastReason"),
                "lastError": item.get("lastError"),
                "resultError": row.get("error"),
                "wallMs": item.get("lastAttemptWallMs") or row.get("wallMs"),
                "frontierPath": item.get("frontierPath"),
                "lastRunId": item.get("lastRunId"),
                "diagnosis": diag,
                "frontier_summary": {
                    "exists": (item.get("frontier") or {}).get("exists"),
                    "by_state_relevance": (item.get("frontier") or {}).get("by_state_relevance"),
                    "pdf_found": (item.get("frontier") or {}).get("pdf_found"),
                    "pdf_completed": (item.get("frontier") or {}).get("pdf_completed"),
                    "unresolved_cr": (item.get("frontier") or {}).get("unresolved_critical_relevant"),
                    "null_retry": (item.get("frontier") or {}).get("null_retry_next"),
                    "run": (item.get("frontier") or {}).get("run"),
                    "retry_n": len((item.get("frontier") or {}).get("retry_pending") or []),
                    "blocked_n": len((item.get("frontier") or {}).get("technical_blocked") or []),
                    "mid_n": len((item.get("frontier") or {}).get("fetched_parsed_mid") or []),
                },
            }
        )

    out = {
        "checkpointSha": report.get("checkpointShaAfterClearIP") or report.get("checkpointSha"),
        "dbSha": report.get("dbSha"),
        "retryCount": len(enriched),
        "byClass": dict(by_class),
        "leads": enriched,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"retryCount": len(enriched), "byClass": dict(by_class)}, indent=2))
    for e in enriched:
        d = e["diagnosis"]
        print(f"{d['class']}\t{e['leadId']}\t{e.get('lastReason')}\t{e.get('companyName')}\t{d['rootCauses']}")


if __name__ == "__main__":
    main()
