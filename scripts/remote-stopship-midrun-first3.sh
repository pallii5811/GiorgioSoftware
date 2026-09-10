#!/usr/bin/env bash
# Mid-run corpus-12 check for first 3 leads. Read-only unless STOP criteria fire.
set -euo pipefail
OUT=/tmp/stopship-forensic
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
LOG=/opt/leadsniper-revalidate/logs/stopship-corpus12.log
IDS_FILE=$OUT/tech-ids.txt
mkdir -p "$OUT"

python3 - <<'PY'
import json, sqlite3, os, re, time
from pathlib import Path
from datetime import datetime, timezone

OUT = Path("/tmp/stopship-forensic")
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
LOG = Path("/opt/leadsniper-revalidate/logs/stopship-corpus12.log")
ids = Path("/tmp/stopship-forensic/tech-ids.txt").read_text().strip().splitlines()
first3 = ids[:3]
c = json.loads(CP.read_text())
term = c.get("terminal") or {}
retry = c.get("retryQueue") or {}
ip = c.get("inProgress") or {}
attempts = c.get("attempts") or {}

results_dirs = [
    Path("/opt/leadsniper-revalidate/data/revalidation/results"),
    Path("/opt/leadsniper-revalidate/app/data/revalidation/results"),
]

def load_result(lid):
    best, path = None, None
    for d in results_dirs:
        for name in (f"{lid}.json", f"{lid}.p1.json", f"{lid}.p2.json"):
            p = d / name
            if not p.exists():
                continue
            try:
                j = json.loads(p.read_text(encoding="utf-8", errors="replace"))
                mtime = p.stat().st_mtime
                if best is None or mtime > best[0]:
                    best = (mtime, j, str(p))
            except Exception:
                pass
    if not best:
        return None, None
    return best[1], best[2]

def frontier_stats(fp):
    if not fp or not Path(fp).exists():
        return {"exists": False}
    try:
        conn = sqlite3.connect(fp)
        conn.row_factory = sqlite3.Row
        # discover schema
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        out = {"exists": True, "path": fp, "tables": tables}
        # try common node table names
        for t in ("nodes", "frontier_nodes", "FrontierNode", "crawl_nodes"):
            if t in tables:
                cols = [r[1] for r in conn.execute(f"PRAGMA table_info({t})").fetchall()]
                out["nodeTable"] = t
                out["cols"] = cols
                total = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                out["nodesTotal"] = total
                # state column
                state_col = next((x for x in cols if x.lower() in ("state", "status", "node_state")), None)
                if state_col:
                    rows = conn.execute(f"SELECT {state_col} as s, COUNT(*) c FROM {t} GROUP BY {state_col}").fetchall()
                    out["byState"] = {str(r["s"]): r["c"] for r in rows}
                    # unresolved relevant heuristic
                    unresolved = 0
                    for r in rows:
                        s = str(r["s"] or "").upper()
                        if s in ("PENDING", "QUEUED", "IN_PROGRESS", "RETRY", "DISCOVERED", "OPEN", "TECHNICAL_BLOCKED"):
                            unresolved += r["c"]
                    out["unresolvedApprox"] = unresolved
                # url/type hints
                url_col = next((x for x in cols if "url" in x.lower()), None)
                type_col = next((x for x in cols if x.lower() in ("kind", "type", "node_type", "content_type")), None)
                if url_col:
                    pdfs = conn.execute(
                        f"SELECT COUNT(*) FROM {t} WHERE LOWER({url_col}) LIKE '%.pdf%'"
                    ).fetchone()[0]
                    out["pdfNodes"] = pdfs
                if type_col:
                    types = conn.execute(
                        f"SELECT {type_col} as t, COUNT(*) c FROM {t} GROUP BY {type_col}"
                    ).fetchall()
                    out["byType"] = {str(r["t"]): r["c"] for r in types}
                break
        # crawl_runs
        for t in ("crawl_runs", "runs", "CrawlRun"):
            if t in tables:
                out["runs"] = [dict(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 3").fetchall()]
                break
        conn.close()
        return out
    except Exception as e:
        return {"exists": True, "path": fp, "error": str(e)}

def ps(v):
    if isinstance(v, str):
        return v.upper()
    return str((v or {}).get("processingState") or (v or {}).get("state") or "").upper()

log_text = LOG.read_text(encoding="utf-8", errors="replace") if LOG.exists() else ""

reports = []
stop_reasons = []
reliable = 0
retry_same = 0

for lid in first3:
    res, rpath = load_result(lid)
    in_term = lid in term
    in_retry = lid in retry
    in_prog = lid in ip
    meta_ip = ip.get(lid) if in_prog else None
    meta_rq = retry.get(lid) if in_retry else None
    meta_tm = term.get(lid) if in_term else None

    state = None
    if in_term:
        state = ps(meta_tm)
        bucket = "terminal"
    elif in_prog:
        state = "IN_PROGRESS"
        bucket = "inProgress"
    elif in_retry:
        state = ps(meta_rq) or (meta_rq or {}).get("lastReason") or "RETRY"
        bucket = "retry"
    else:
        state = "UNKNOWN"
        bucket = "unknown"

    # prefer result processingState if fresher for finished
    if res and not in_prog:
        state = res.get("processingState") or state

    ev = (res or {}).get("fullEvidence") or ""
    err = (res or {}).get("error")
    wall = (res or {}).get("wallMs")
    crawl = (res or {}).get("crawlComplete")
    pages = (res or {}).get("pagesVisited")
    reason = (res or {}).get("reasonCode")
    ocr_missing = bool(re.search(r"OCR_RENDERER_MISSING", ev + json.dumps(res or {}), re.I))
    ocr_req = bool(re.search(r"OCR_|OCR_REQUIRED|needsOcr|ocrRequired", ev + json.dumps(res or {}), re.I))
    ocr_done = bool(re.search(r"OCR_OK|OCR_DONE|OCR_PAGE|tesseract", ev, re.I)) and not ocr_missing

    # PDF counts from evidence/result
    pdf_urls = sorted(set(re.findall(r"https?://[^\s\"'<>\\]+\.pdf[^\s\"'<>\\]*", ev + json.dumps(res or {}), re.I)))
    pdf_read = len(re.findall(r"PDF_(OK|PARSED|TEXT|OCR)|pdfParsed|pagesExtracted", ev, re.I))

    # frontier path
    fp = None
    if meta_ip and isinstance(meta_ip, dict):
        fp = meta_ip.get("frontierPath")
    if not fp and meta_rq and isinstance(meta_rq, dict):
        fp = meta_rq.get("frontierPath")
    if not fp and res:
        fps = res.get("frontierPaths") or []
        fp = fps[-1] if fps else (res.get("pass1") or {}).get("frontierPath")
    fstat = frontier_stats(fp)

    # duration: from inProgress startedAt or result wallMs / finishedAt
    duration_s = None
    if wall:
        duration_s = round(wall / 1000)
    elif meta_ip and meta_ip.get("startedAt"):
        try:
            t0 = datetime.fromisoformat(meta_ip["startedAt"].replace("Z", "+00:00"))
            duration_s = int((datetime.now(timezone.utc) - t0).total_seconds())
        except Exception:
            pass

    # last progress from log lines for this id
    jlines = [ln for ln in log_text.splitlines() if lid in ln][-15:]

    # resume vs restart
    resume = any("frontier_resume" in ln and lid in ln for ln in log_text.splitlines())
    # check if attempts restarted from zero incorrectly mid-run — demote set 0 intentionally
    att = attempts.get(lid)

    outcome = state
    commercial = state in (
        "PUBLISHED_CURRENT", "PUBLISHED_EXPIRED", "PUBLISHED_DATE_UNKNOWN", "HOT_VERIFIED", "REVIEW_HUMAN"
    )
    if commercial:
        reliable += 1
    if bucket == "retry" or (res and (res.get("processingState") in (None, "RETRY_PENDING", "TECHNICAL_BLOCKED") or res.get("error"))):
        if not in_prog and not commercial:
            retry_same += 1

    # HOT with unresolved
    if state == "HOT_VERIFIED" and (fstat.get("unresolvedApprox") or 0) > 0:
        stop_reasons.append(f"{lid}: HOT_VERIFIED with unresolved frontier nodes={fstat.get('unresolvedApprox')}")
    if ocr_missing:
        stop_reasons.append(f"{lid}: OCR_RENDERER_MISSING")
    if duration_s and duration_s >= 3600 and in_prog:
        # check frontier mtime progress
        if fp and Path(fp).exists():
            age = time.time() - Path(fp).stat().st_mtime
            if age > 3600:
                stop_reasons.append(f"{lid}: >=60min without frontier file mtime progress (age={int(age)}s)")

    # Published evidence quality
    if state and str(state).startswith("PUBLISHED"):
        has_doc = bool(pdf_urls) or bool(re.search(r"policyPdf|evidenceUrl|documento", ev, re.I))
        has_hash = bool(re.search(r"sha256|SHA-256|contentHash", ev, re.I))
        has_cite = bool(re.search(r"page=\d+|pagina|citation|quote", ev, re.I))
        if not (has_doc and has_hash and has_cite):
            stop_reasons.append(f"{lid}: PUBLISHED missing doc/url/hash/citation (doc={has_doc},hash={has_hash},cite={has_cite})")

    reports.append({
        "leadId": lid,
        "companyName": (res or {}).get("companyName"),
        "website": (res or {}).get("website"),
        "bucket": bucket,
        "state": outcome,
        "durationSec": duration_s,
        "wallMs": wall,
        "attempts": att,
        "error": err,
        "reasonCode": reason,
        "crawlComplete": crawl,
        "pagesVisited": pages,
        "frontierResumeSeen": resume,
        "frontier": fstat,
        "pdfFoundUrls": len(pdf_urls),
        "pdfUrlsSample": pdf_urls[:8],
        "pdfReadSignals": pdf_read,
        "ocrRequiredHint": ocr_req,
        "ocrExecutedHint": ocr_done,
        "ocrRendererMissing": ocr_missing,
        "resultPath": rpath,
        "logTail": jlines[-8:],
        "inProgressMeta": meta_ip,
        "retryMeta": {k: meta_rq.get(k) for k in ("lastReason", "lastError", "attempts", "frontierPath", "lastRunId", "demotedAt") if isinstance(meta_rq, dict) and k in meta_rq} if meta_rq else None,
        "terminalMeta": meta_tm,
    })

# If all 3 finished into retry for same cause
finished = [r for r in reports if r["bucket"] != "inProgress"]
if len(finished) >= 3:
    causes = []
    for r in finished:
        causes.append(r.get("error") or r.get("reasonCode") or r.get("state"))
    if len(set(causes)) == 1 and all(
        (x or "").upper() in ("RETRY_PENDING", "TECHNICAL_BLOCKED") or "TIMEOUT" in str(x or "").upper() or "RETRY" in str(x or "").upper()
        for x in causes
    ):
        stop_reasons.append(f"first3_all_retry_same_cause:{causes[0]}")

decision = "CONTINUE" if (reliable >= 2 and not stop_reasons) else ("STOP" if stop_reasons or (len(finished) >= 3 and reliable < 2) else "WAIT")
# If still running first leads, WAIT unless stop criteria
if any(r["bucket"] == "inProgress" for r in reports) and not stop_reasons:
    decision = "WAIT_IN_PROGRESS"
if stop_reasons:
    decision = "STOP"

out = {
    "checkedAt": datetime.now(timezone.utc).isoformat(),
    "first3": first3,
    "decision": decision,
    "reliableCount": reliable,
    "stopReasons": stop_reasons,
    "corpusAlive": Path("/tmp/stopship-forensic/corpus12.pid").exists(),
    "reports": reports,
}
Path("/tmp/stopship-forensic/midrun-first3.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps(out, indent=2, ensure_ascii=False))
PY
