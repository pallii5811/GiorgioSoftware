#!/usr/bin/env python3
"""Repair existing revalidation checkpoint + frontier orphans without reset.

- Assign nextRetryAt to lead retryQueue entries missing/due-spam
- Demote attempts >= MAX (5) to TECHNICAL_BLOCKED terminal
- Preserve terminal (Villa Angela / Dei Pini / Malzoni etc.)
- Repair RETRY_PENDING nodes with null nextRetryAt in frontier sqlite files
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_RETRY = 5
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
FRONTIER_DIR = Path("/opt/leadsniper-revalidate/data/revalidation/frontiers")
PROTECTED_NAME_HINTS = ("villa angela", "villa dei pini", "malzoni", "dei pini")


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    assert CP.exists(), CP
    bak = CP.with_suffix(f".json.bak-stopship-{int(time.time())}")
    shutil.copy2(CP, bak)
    before_sha = sha256(CP)
    cp = json.loads(CP.read_text(encoding="utf-8"))
    terminal_before = dict(cp.get("terminal") or {})
    rq = dict(cp.get("retryQueue") or {})
    attempts = dict(cp.get("attempts") or {})

    now = datetime.now(timezone.utc)
    repaired_queue = 0
    demoted = []
    for lid, meta in list(rq.items()):
        att = int(meta.get("attempts") or attempts.get(lid) or 0)
        attempts[lid] = max(int(attempts.get(lid) or 0), att)
        if att >= MAX_RETRY:
            cp.setdefault("terminal", {})[lid] = {
                "finishedAt": now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
                "processingState": "TECHNICAL_BLOCKED",
                "newVerdict": None,
                "reasonCode": f"RETRY_EXHAUSTED_{att}:{meta.get('lastReason') or 'STOPSHIP'}",
            }
            demoted.append(lid)
            del rq[lid]
            cp.setdefault("stats", {})
            cp["stats"]["tech"] = int(cp["stats"].get("tech") or 0) + 1
            cp["stats"]["terminal"] = int(cp["stats"].get("terminal") or 0) + 1
            continue
        nxt = meta.get("nextRetryAt")
        if not nxt:
            # controlled backoff by attempts
            delay = min(20 * 60, 90 * (2 ** min(att, 4)))
            meta["nextRetryAt"] = (now + timedelta(seconds=delay)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            meta["repairedNullNextRetryAt"] = True
            repaired_queue += 1
        # preserve frontierPath / lastRunId
        rq[lid] = meta

    # clear inProgress so resume is clean (locks may be stale after stop)
    cleared_ip = list((cp.get("inProgress") or {}).keys())
    cp["inProgress"] = {}
    cp["retryQueue"] = rq
    cp["attempts"] = attempts
    cp["updatedAt"] = now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    # verify protected terminals unchanged
    for lid, meta in terminal_before.items():
        assert cp["terminal"][lid] == meta, f"terminal mutated {lid}"

    tmp = CP.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CP)
    after_sha = sha256(CP)

    # repair frontier sqlite orphans
    null_before = 0
    null_after = 0
    frontiers_touched = 0
    for dbp in FRONTIER_DIR.glob("*.sqlite"):
        try:
            con = sqlite3.connect(str(dbp))
            before = con.execute(
                "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt='')"
            ).fetchone()[0]
            null_before += before
            if before:
                # assign backoff from retryCount
                rows = con.execute(
                    "SELECT id, retryCount FROM CrawlFrontierNode WHERE state='RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt='')"
                ).fetchall()
                for nid, rc in rows:
                    delay_ms = min(300_000, 2000 * (2 ** max(0, int(rc or 0))))
                    nxt = (now + timedelta(milliseconds=delay_ms)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
                    con.execute(
                        "UPDATE CrawlFrontierNode SET nextRetryAt=?, lastError=COALESCE(lastError, ?) WHERE id=?",
                        (nxt, "repaired_null_nextRetryAt", nid),
                    )
                con.commit()
                frontiers_touched += 1
            after = con.execute(
                "SELECT count(*) FROM CrawlFrontierNode WHERE state='RETRY_PENDING' AND (nextRetryAt IS NULL OR nextRetryAt='')"
            ).fetchone()[0]
            null_after += after
            con.close()
        except Exception as e:
            print("frontier_skip", dbp.name, e)

    print(
        json.dumps(
            {
                "backup": str(bak),
                "checkpoint_sha_before": before_sha,
                "checkpoint_sha_after": after_sha,
                "terminal_preserved": len(terminal_before),
                "demoted_to_tech": demoted,
                "retry_queue_repaired_null": repaired_queue,
                "cleared_inProgress": cleared_ip,
                "frontier_null_before": null_before,
                "frontier_null_after": null_after,
                "frontiers_touched": frontiers_touched,
                "retry_left": len(rq),
                "terminal_now": len(cp.get("terminal") or {}),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
