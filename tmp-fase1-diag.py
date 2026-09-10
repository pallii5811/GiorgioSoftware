#!/usr/bin/env python3
"""FASE1 — real diagnostics for targeted 16."""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from pathlib import Path

TARGET = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
OUT = TARGET / "FASE1_DIAGNOSIS.json"

ENGINE_MARKERS = (
    "PLAYWRIGHT",
    "Executable doesn't exist",
    "browserType.launch",
    "OCR_TIMEOUT",
    "LEAD_WALL",
    "ANALYZE_",
    "FRONTIER_INCOMPLETE",
    "CRAWL_CAP",
    "URL_CAP",
    "RUN_WALL",
    "NODE_STALL",
    "LOW_RELEVANCE",
    "BROWSER",
    "Timeout lock",
    "SLICE_BUDGET",
)
EXTERNAL_MARKERS = (
    "NXDOMAIN",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "CERT_",
    "SSL_",
    "TLS",
    "UNABLE_TO_VERIFY",
    "WAF",
    "http_5",
    "HTTP_5",
    "429",
    "PDF_CORRUPT",
    "OCR_RENDERER_MISSING",
)


def classify(blob: str, state: str) -> str:
    b = blob or ""
    if state == "TECHNICAL_BLOCKED":
        if any(m.lower() in b.lower() for m in EXTERNAL_MARKERS) and not any(
            m.lower() in b.lower() for m in ("PLAYWRIGHT", "Executable", "LEAD_WALL", "OCR_TIMEOUT")
        ):
            return "EXTERNAL_PROVEN"
        return "ENGINE_BUG"
    if any(m.lower() in b.lower() for m in ENGINE_MARKERS):
        return "ENGINE_BUG"
    if any(m.lower() in b.lower() for m in ("identity", "mismatch", "REVIEW_HUMAN", "ambiguous")):
        return "IDENTITY_REVIEW"
    if any(m.lower() in b.lower() for m in EXTERNAL_MARKERS):
        return "TRANSIENT_EXTERNAL"
    if state in (
        "HOT_VERIFIED",
        "PUBLISHED_CURRENT",
        "PUBLISHED_EXPIRED",
        "PUBLISHED_DATE_UNKNOWN",
        "SELF_INSURANCE_VERIFIED",
        "REVIEW_HUMAN",
        "OUT_OF_SCOPE",
    ):
        return "DONE_TERMINAL"
    return "ENGINE_BUG"


def frontier_detail(fp: str | None) -> dict:
    if not fp or not Path(fp).exists():
        return {"exists": False}
    con = sqlite3.connect(fp)
    try:
        by_state = dict(
            con.execute("SELECT state, count(*) FROM CrawlFrontierNode GROUP BY state").fetchall()
        )
        by_rel = dict(
            con.execute(
                "SELECT COALESCE(relevance,'?'), count(*) FROM CrawlFrontierNode GROUP BY relevance"
            ).fetchall()
        )
        unresolved = con.execute(
            "SELECT id, canonicalUrl, relevance, state FROM CrawlFrontierNode "
            "WHERE relevance IN ('critical','relevant') "
            "AND state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING') "
            "LIMIT 40"
        ).fetchall()
        null_retry = con.execute(
            "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' "
            "AND (nextRetryAt IS NULL OR nextRetryAt='')"
        ).fetchone()[0]
        pdfs = con.execute(
            "SELECT state, count(*) FROM CrawlFrontierNode "
            "WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
        ).fetchall()
        run = None
        try:
            cols = {r[1] for r in con.execute("PRAGMA table_info(CrawlRun)").fetchall()}
            select = ["id", "state"]
            for c in ("sitemapStatus", "urlCapReached", "timeCapReached", "stopReason", "startedAt", "finishedAt"):
                if c in cols:
                    select.append(c)
            run_row = con.execute(f"SELECT {', '.join(select)} FROM CrawlRun LIMIT 1").fetchone()
            if run_row:
                run = dict(zip(select, run_row))
        except Exception as e:
            run = {"error": str(e)}
        return {
            "exists": True,
            "byState": by_state,
            "byRelevance": by_rel,
            "nullRetry": null_retry,
            "pdfs": {s: c for s, c in pdfs},
            "unresolvedCR": [
                {"id": r[0], "url": r[1], "relevance": r[2], "state": r[3]} for r in unresolved
            ],
            "run": run,
        }
    finally:
        con.close()


def main() -> None:
    ids = json.loads((TARGET / "ids.json").read_text())["ids"]
    cp = json.loads((TARGET / "checkpoint.json").read_text())
    term = cp.get("terminal") or {}
    retry = cp.get("retryQueue") or {}
    ip = cp.get("inProgress") or {}
    attempts = cp.get("attempts") or {}
    results = TARGET / "results"
    rows = []
    classes = Counter()

    for lid in ids:
        meta = retry.get(lid) or {}
        tmeta = term.get(lid) if isinstance(term.get(lid), dict) else {}
        ipmeta = ip.get(lid) or {}
        rp = results / f"{lid}.json"
        row = {}
        if rp.exists():
            try:
                row = json.loads(rp.read_text(encoding="utf-8"))
            except Exception as e:
                row = {"parseError": str(e)}

        fps = row.get("frontierPaths") or []
        fp = meta.get("frontierPath") or tmeta.get("frontierPath") or ipmeta.get("frontierPath")
        if fps:
            name = Path(fps[0]).name
            cand = TARGET / "frontiers" / name
            fp = str(cand if cand.exists() else fps[0])
        # also try glob by lead id
        if not fp or not Path(fp).exists():
            cands = list((TARGET / "frontiers").glob(f"*{lid}*.sqlite"))
            if cands:
                fp = str(sorted(cands, key=lambda p: p.stat().st_mtime)[-1])

        fr = frontier_detail(fp)
        blob = " ".join(
            [
                str(meta.get("lastReason") or ""),
                str(meta.get("lastError") or ""),
                str(row.get("reasonCode") or ""),
                str(row.get("error") or ""),
                str(row.get("errorClass") or ""),
                str(row.get("stackSynth") or ""),
                str(row.get("stage") or ""),
            ]
        )
        state = (
            row.get("processingState")
            or (tmeta.get("processingState") if tmeta else None)
            or ("RETRY_PENDING" if lid in retry else ("IN_PROGRESS" if lid in ip else "UNKNOWN"))
        )
        cls = classify(blob, str(state))
        classes[cls] += 1
        rows.append(
            {
                "leadId": lid,
                "struttura": row.get("companyName") or meta.get("companyName"),
                "website": row.get("website"),
                "attempts": int(attempts.get(lid) or meta.get("attempts") or 0),
                "lastReason": meta.get("lastReason") or row.get("reasonCode"),
                "lastError": meta.get("lastError") or row.get("error"),
                "errorClass": row.get("errorClass"),
                "failingStage": row.get("stage") or row.get("failingStage"),
                "failingUrl": row.get("failingUrl"),
                "failingNodeId": row.get("failingNodeId"),
                "stackSynth": (row.get("stackSynth") or "")[:800],
                "runId": meta.get("lastRunId") or ipmeta.get("runId") or row.get("runId"),
                "frontierPath": fp,
                "lastHeartbeat": row.get("lastHeartbeat") or ipmeta.get("heartbeatAt"),
                "wallMs": row.get("wallMs") or row.get("elapsedMs"),
                "playwrightStatus": row.get("playwrightStatus"),
                "chromiumExecutablePath": row.get("chromiumExecutablePath")
                or row.get("executablePath"),
                "sitemapStatus": (fr.get("run") or {}).get("sitemapStatus") if fr.get("exists") else None,
                "frontier": fr,
                "ocrStatus": row.get("ocrStatus"),
                "resultFile": rp.exists(),
                "processingState": state,
                "classification": cls,
                "nextRetryAt": meta.get("nextRetryAt"),
                "inProgress": lid in ip,
                "terminal": lid in term,
            }
        )

    report = {
        "total": len(ids),
        "classCounts": dict(classes),
        "rows": rows,
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    slim = {
        "total": report["total"],
        "classCounts": report["classCounts"],
        "summary": [
            {
                "leadId": r["leadId"],
                "struttura": r["struttura"],
                "state": r["processingState"],
                "attempts": r["attempts"],
                "lastReason": r["lastReason"],
                "errorClass": r["errorClass"],
                "stage": r["failingStage"],
                "url": r["failingUrl"],
                "class": r["classification"],
                "result": r["resultFile"],
                "sitemap": r["sitemapStatus"],
                "unresolvedCR": len((r["frontier"].get("unresolvedCR") or [])),
                "pdfs": (r["frontier"].get("pdfs") if r["frontier"].get("exists") else None),
            }
            for r in rows
        ],
    }
    print(json.dumps(slim, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
