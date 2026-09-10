#!/usr/bin/env bash
set -euo pipefail
python3 <<'PY'
import sqlite3, json
from pathlib import Path

paths = {
  "1_Villa_Maione": "/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmqkld5s700a8108eti0nofjv-1784574907297.sqlite",
  "2_Pineta_Grande": "/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqkld5rx009p108edj6t9krw-1784585646000.sqlite",
  "3_Nuova_Alba": "/opt/leadsniper-revalidate/app/data/revalidation/frontiers/reval-p1-cmql46eia000ac9w78xh0rxdl-1784579490121.sqlite",
}
out = {}
for name, fp in paths.items():
    p = Path(fp)
    if not p.exists():
        out[name] = {"missing": True}
        continue
    conn = sqlite3.connect(fp)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(CrawlFrontierNode)").fetchall()]
    by_state = dict(conn.execute("SELECT state, COUNT(*) c FROM CrawlFrontierNode GROUP BY state").fetchall())
    total = conn.execute("SELECT COUNT(*) FROM CrawlFrontierNode").fetchone()[0]
    completed_states = ("COMPLETED", "DONE", "SUCCESS", "FETCHED", "PARSED")
    unresolved = sum(v for k, v in by_state.items() if str(k).upper() not in completed_states and str(k).upper() not in ("SKIPPED", "IRRELEVANT", "OUT_OF_SCOPE"))
    # refine: treat FAILED as unresolved relevant
    pdf = 0
    pdf_done = 0
    if "url" in cols:
        pdf = conn.execute("SELECT COUNT(*) FROM CrawlFrontierNode WHERE LOWER(url) LIKE '%.pdf%'").fetchone()[0]
        pdf_done = conn.execute(
            "SELECT COUNT(*) FROM CrawlFrontierNode WHERE LOWER(url) LIKE '%.pdf%' AND UPPER(COALESCE(state,'')) IN ('COMPLETED','DONE','SUCCESS','FETCHED','PARSED')"
        ).fetchone()[0]
    run = conn.execute(
        "SELECT totalDiscovered,totalRelevant,totalCompleted,totalPending,totalFailed,stopReason,currentCheckpoint,heartbeatAt,state FROM CrawlRun ORDER BY rowid DESC LIMIT 1"
    ).fetchone()
    run_d = None
    if run:
        keys = ["totalDiscovered","totalRelevant","totalCompleted","totalPending","totalFailed","stopReason","currentCheckpoint","heartbeatAt","state"]
        run_d = dict(zip(keys, run))
    out[name] = {
        "initialFinalFromRun": {
            "discovered": run_d["totalDiscovered"] if run_d else None,
            "relevant": run_d["totalRelevant"] if run_d else None,
            "completed": run_d["totalCompleted"] if run_d else None,
            "pending": run_d["totalPending"] if run_d else None,
            "failed": run_d["totalFailed"] if run_d else None,
        },
        "nodesTotal": total,
        "byState": by_state,
        "unresolvedNodes": unresolved,
        "pdfNodes": pdf,
        "pdfCompleted": pdf_done,
        "run": run_d,
        "colsSample": cols,
    }
    conn.close()
Path("/tmp/stopship-forensic/midrun-frontier-detail.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
print(json.dumps(out, indent=2))
PY
