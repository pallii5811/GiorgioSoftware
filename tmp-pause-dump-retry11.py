#!/usr/bin/env python3
"""Pause revalidate + dump exact 11-retry matrix with frontier/log detail."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11")
PROD_CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RESULTS = Path("/opt/leadsniper-revalidate/data/revalidation/results")
LOG = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log")
APP = Path("/opt/leadsniper-revalidate/app")


def sha(p: Path | str | None) -> str | None:
    if not p:
        return None
    p = Path(p)
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def pause() -> str:
    subprocess.run(["systemctl", "stop", "giorgio-revalidate"], check=False)
    import time

    time.sleep(2)
    r = subprocess.run(["systemctl", "is-active", "giorgio-revalidate"], capture_output=True, text=True)
    return (r.stdout or r.stderr or "").strip()


def lead_meta(lead_id: str, env: dict) -> dict:
    script = f"""
const {{ PrismaClient }} = require('@prisma/client');
const p = new PrismaClient();
(async () => {{
  try {{
    const r = await p.lead.findUnique({{
      where: {{ id: '{lead_id}' }},
      select: {{ id: true, companyName: true, website: true, name: true }},
    }});
    console.log(JSON.stringify(r || {{}}));
  }} catch (e) {{
    console.log(JSON.stringify({{ error: String(e) }}));
  }} finally {{
    await p['$disconnect']().catch(() => {{}});
  }}
}})();
"""
    path = Path(f"/tmp/leadmeta-{lead_id}.cjs")
    path.write_text(script)
    try:
        out = subprocess.check_output(["node", str(path)], cwd=str(APP), env=env, text=True, timeout=30)
        return json.loads(out.strip().splitlines()[-1])
    except Exception as e:
        return {"error": str(e)}


def frontier_detail(fp: str | None) -> dict:
    if not fp or not Path(fp).exists():
        return {"exists": False}
    con = sqlite3.connect(fp)
    con.row_factory = sqlite3.Row
    try:
        by_state_rel = [
            dict(r)
            for r in con.execute(
                "SELECT state, relevance, COUNT(*) AS c FROM CrawlFrontierNode GROUP BY state, relevance"
            ).fetchall()
        ]
        retry_urls = [
            dict(r)
            for r in con.execute(
                """SELECT id, canonicalUrl, state, relevance, resourceType, httpStatus, lastError,
                          nextRetryAt, retryCount, contentHash
                   FROM CrawlFrontierNode WHERE state='RETRY_PENDING'"""
            ).fetchall()
        ]
        blocked = [
            dict(r)
            for r in con.execute(
                """SELECT id, canonicalUrl, state, relevance, resourceType, httpStatus, lastError, retryCount
                   FROM CrawlFrontierNode WHERE state='TECHNICAL_BLOCKED'"""
            ).fetchall()
        ]
        mid = [
            dict(r)
            for r in con.execute(
                """SELECT id, canonicalUrl, state, relevance, resourceType, httpStatus, lastError
                   FROM CrawlFrontierNode WHERE state IN ('FETCHED','PARSED','FETCHING','RENDERED')"""
            ).fetchall()
        ]
        pdfs = [
            dict(r)
            for r in con.execute(
                """SELECT id, canonicalUrl, state, relevance, lastError, httpStatus, contentHash
                   FROM CrawlFrontierNode
                   WHERE resourceType='pdf' OR lower(canonicalUrl) LIKE '%.pdf%'"""
            ).fetchall()
        ]
        run = con.execute("SELECT * FROM CrawlRun LIMIT 1").fetchone()
        run_d = dict(run) if run else {}
        # evidence OCR-ish
        ev = []
        try:
            ev = [
                dict(r)
                for r in con.execute(
                    """SELECT nodeId, canonicalUrl, ocrStatus, policyFound,
                              length(COALESCE(normalizedText,'')) AS textLen
                       FROM CrawlNodeEvidence LIMIT 50"""
                ).fetchall()
            ]
        except Exception:
            pass
        unresolved_cr = con.execute(
            """SELECT COUNT(*) FROM CrawlFrontierNode
               WHERE relevance IN ('critical','relevant')
                 AND state IN ('DISCOVERED','QUEUED','FETCHING','FETCHED','RENDERED','PARSED','RETRY_PENDING')"""
        ).fetchone()[0]
        return {
            "exists": True,
            "by_state_relevance": by_state_rel,
            "retry_pending": retry_urls,
            "technical_blocked": blocked,
            "fetched_parsed_mid": mid,
            "pdfs": pdfs,
            "pdf_found": len(pdfs),
            "pdf_completed": sum(1 for p in pdfs if p.get("state") == "COMPLETED"),
            "evidence_sample": ev[:20],
            "run": {
                "state": run_d.get("state"),
                "sitemapStatus": run_d.get("sitemapStatus"),
                "urlCapReached": run_d.get("urlCapReached"),
                "timeCapReached": run_d.get("timeCapReached"),
                "lastHeartbeatAt": run_d.get("lastHeartbeatAt") or run_d.get("updatedAt"),
                "heartbeatNote": run_d.get("heartbeatNote") or run_d.get("lastHeartbeat") or run_d.get("stopReason"),
                "identityVerified": run_d.get("identityVerified"),
                "scopeVerified": run_d.get("scopeVerified"),
            },
            "unresolved_critical_relevant": unresolved_cr,
            "null_retry_next": con.execute(
                """SELECT COUNT(*) FROM CrawlFrontierNode
                   WHERE state='RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt='')"""
            ).fetchone()[0],
        }
    finally:
        con.close()


def log_snippets(lead_id: str, lines: list[str], n: int = 40) -> list[str]:
    hits = []
    for i, line in enumerate(lines):
        if lead_id in line:
            hits.append(i)
    out = []
    for i in hits[-8:]:
        lo = max(0, i - 3)
        hi = min(len(lines), i + 4)
        out.append("---")
        out.extend(lines[lo:hi])
    # also search worker stderr patterns near lead
    return out[-n:]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    status = pause()
    cp = json.loads(PROD_CP.read_text())
    rq = cp.get("retryQueue") or {}
    assert len(rq) >= 1, "no retries"

    env = {}
    show = subprocess.check_output(
        ["systemctl", "show", "giorgio-revalidate", "-p", "Environment", "--value"], text=True
    )
    for part in show.split(" "):
        if "=" in part:
            k, _, v = part.partition("=")
            if k.isupper():
                env[k] = v
    import os

    full_env = os.environ.copy()
    full_env.update(env)

    db_path = None
    for p in [
        Path("/opt/leadsniper-revalidate/data/prisma/dev.db"),
        Path("/opt/leadsniper-revalidate/app/prisma/dev.db"),
        Path("/opt/leadsniper/prisma/dev.db"),
    ]:
        if p.exists():
            db_path = p
            break

    log_lines = LOG.read_text(errors="replace").splitlines() if LOG.exists() else []

    matrix = []
    for lid, meta in rq.items():
        lm = lead_meta(lid, full_env)
        res_path = RESULTS / f"{lid}.json"
        p1_path = RESULTS / f"{lid}.p1.json"
        row = {}
        wall_ms = None
        if res_path.exists():
            try:
                row = json.loads(res_path.read_text())
                wall_ms = row.get("wallMs") or (row.get("pass1") or {}).get("wallMs")
            except Exception as e:
                row = {"parseError": str(e)}
        # last worker_done wall from log
        for line in reversed(log_lines):
            if lid in line and "worker_done" in line:
                try:
                    ev = json.loads(line)
                    wall_ms = wall_ms or ev.get("wallMs")
                except Exception:
                    pass
                break
        fp = meta.get("frontierPath")
        item = {
            "leadId": lid,
            "companyName": lm.get("companyName") or lm.get("name") or row.get("companyName"),
            "website": lm.get("website") or row.get("website"),
            "attempts": meta.get("attempts"),
            "lastReason": meta.get("lastReason"),
            "lastError": meta.get("lastError") or meta.get("lastReason"),
            "nextRetryAt": meta.get("nextRetryAt"),
            "lastRunId": meta.get("lastRunId"),
            "frontierPath": fp,
            "resultFile": str(res_path) if res_path.exists() else None,
            "p1File": str(p1_path) if p1_path.exists() else None,
            "lastAttemptWallMs": wall_ms,
            "resultSnapshot": {
                "processingState": row.get("processingState"),
                "reasonCode": row.get("reasonCode"),
                "error": row.get("error"),
                "stage": row.get("stage") or row.get("lastStage"),
                "errorClass": row.get("errorClass"),
                "failingUrl": row.get("failingUrl"),
                "newVerdict": row.get("newVerdict"),
            },
            "frontier": frontier_detail(fp),
            "logTail": log_snippets(lid, log_lines),
        }
        matrix.append(item)

    report = {
        "pausedAt": datetime.now(timezone.utc).isoformat(),
        "service": status,
        "checkpointSha": sha(PROD_CP),
        "dbPath": str(db_path) if db_path else None,
        "dbSha": sha(db_path),
        "terminalCount": len(cp.get("terminal") or {}),
        "retryCount": len(rq),
        "inProgressCleared": list((cp.get("inProgress") or {}).keys()),
        "matrix": matrix,
    }
    # clear inProgress so resume later is clean — do NOT demote retries
    cp["inProgress"] = {}
    cp["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    tmp = PROD_CP.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PROD_CP)
    report["checkpointShaAfterClearIP"] = sha(PROD_CP)

    (OUT / "RETRY11_MATRIX.json").write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    print(json.dumps({k: report[k] for k in report if k != "matrix"}, indent=2))
    print("MATRIX_N", len(matrix))
    for m in matrix:
        print(
            "-",
            m["leadId"],
            m.get("companyName"),
            m.get("lastReason"),
            "attempts",
            m.get("attempts"),
            "frontier",
            m["frontier"].get("exists"),
        )


if __name__ == "__main__":
    main()
