#!/usr/bin/env python3
"""Evaluate stopship canary20 gates; never resume prod here."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import Counter
from pathlib import Path

CANARY = Path("/opt/leadsniper-revalidate/data/stopship-canary20")
PROD_CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")


def sha(p: Path | str | None) -> str | None:
    if not p:
        return None
    p = Path(p)
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    base = json.loads((CANARY / "baseline.json").read_text())
    cp = json.loads((CANARY / "checkpoint.json").read_text())
    ids = json.loads((CANARY / "ids.json").read_text())["ids"]
    results_dir = CANARY / "results"
    frontiers = list((CANARY / "frontiers").glob("*.sqlite"))

    null_retry = 0
    for dbp in frontiers:
        try:
            con = sqlite3.connect(str(dbp))
            null_retry += con.execute(
                "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt='')"
            ).fetchone()[0]
            con.close()
        except Exception:
            pass

    states = Counter()
    false_terms = []
    crawl_cap_low_only = 0
    reachable_done = 0
    tech = 0
    rows = []
    for lid in ids:
        rp = results_dir / f"{lid}.json"
        if not rp.exists():
            rows.append({"id": lid, "state": "MISSING"})
            continue
        row = json.loads(rp.read_text())
        st = row.get("processingState") or row.get("reasonCode") or "?"
        states[st] += 1
        rows.append(
            {
                "id": lid,
                "state": st,
                "verdict": row.get("newVerdict"),
                "reason": row.get("reasonCode"),
                "company": row.get("companyName"),
            }
        )
        if st == "TECHNICAL_BLOCKED" or str(row.get("reasonCode") or "").startswith("RETRY_EXHAUSTED"):
            tech += 1
        if st in {
            "HOT_VERIFIED",
            "PUBLISHED_CURRENT",
            "PUBLISHED_EXPIRED",
            "PUBLISHED_DATE_UNKNOWN",
            "SELF_INSURANCE_VERIFIED",
            "REVIEW_HUMAN",
            "OUT_OF_SCOPE",
            "TECHNICAL_BLOCKED",
        }:
            reachable_done += 1
        # crude false terminal heuristic placeholder — manual audit still required
        if st == "HOT_VERIFIED" and row.get("crawlComplete") is False:
            false_terms.append(lid)

    terminal_n = len(cp.get("terminal") or {})
    retry_n = len(cp.get("retryQueue") or {})
    inprog = list((cp.get("inProgress") or {}).keys())
    done = terminal_n + retry_n == 0 and not inprog and all((results_dir / f"{i}.json").exists() for i in ids)
    # finished when no inProgress and all ids have result and no due-now infinite loop
    finished = (not inprog) and terminal_n + retry_n >= len(ids) or (
        not inprog and sum(1 for i in ids if (results_dir / f"{i}.json").exists()) >= len(ids) and not inprog
    )

    prod_ok = sha(PROD_CP) == base.get("prodCheckpointSha")
    db_ok = sha(base.get("dbPath")) == base.get("dbSha")

    # attempts hot-loop: any attempts > 5 in canary cp
    hot = [ (k,v) for k,v in (cp.get("attempts") or {}).items() if int(v or 0) > 5 ]
    hot += [ (k,m.get("attempts")) for k,m in (cp.get("retryQueue") or {}).items() if int(m.get("attempts") or 0) > 5 ]

    gates = {
        "null_retry_nextRetryAt": null_retry == 0,
        "hot_loop": len(hot) == 0,
        "prod_checkpoint_invariant": prod_ok,
        "db_invariant": db_ok,
        "false_hot_incomplete": len(false_terms) == 0,
        "all_ids_have_result": all((results_dir / f"{i}.json").exists() for i in ids),
        "no_in_progress": len(inprog) == 0,
    }
    report = {
        "finished": bool(gates["all_ids_have_result"] and gates["no_in_progress"]),
        "gates": gates,
        "PASS": all(gates.values()) and reachable_done >= 15,
        "CANARY_TERMINAL": terminal_n,
        "CANARY_RETRY": retry_n,
        "REACHABLE_COMPLETED": reachable_done,
        "TECHNICAL_BLOCKED": tech,
        "FALSE_TERMINALS": false_terms,
        "NULL_RETRY_DATES": null_retry,
        "HOT_LOOPS": hot,
        "states": dict(states),
        "prod_cp_unchanged": prod_ok,
        "db_unchanged": db_ok,
        "rows": rows,
    }
    (CANARY / "CANARY20_REPORT.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in report if k != "rows"}, indent=2))


if __name__ == "__main__":
    main()
