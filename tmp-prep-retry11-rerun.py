#!/usr/bin/env python3
"""Prepare isolated targeted rerun of current prod retryQueue (copies only)."""
from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

PROD_CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
PROD_FRONT = Path("/opt/leadsniper-revalidate/data/revalidation/frontiers")
OUT = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
DB = Path("/opt/leadsniper/prisma/dev.db")


def sha(p: Path) -> str | None:
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "frontiers").mkdir(parents=True)
    (OUT / "results").mkdir(parents=True)
    (OUT / "locks").mkdir(parents=True)

    cp = json.loads(PROD_CP.read_text())
    rq = cp.get("retryQueue") or {}
    ids = list(rq.keys())
    assert ids, "empty retry queue"

    # isolated checkpoint: only these retries, due now, attempts reset to preserve max-5 headroom but keep lastReason
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    iso_rq = {}
    for lid, meta in rq.items():
        fp = meta.get("frontierPath")
        new_fp = None
        if fp and Path(fp).exists():
            dest = OUT / "frontiers" / Path(fp).name
            shutil.copy2(fp, dest)
            # copy wal/shm if any
            for suf in ("-wal", "-shm"):
                side = Path(str(fp) + suf)
                if side.exists():
                    shutil.copy2(side, Path(str(dest) + suf))
            new_fp = str(dest)
        iso_rq[lid] = {
            **meta,
            "attempts": min(int(meta.get("attempts") or 1), 2),  # leave room under max 5
            "nextRetryAt": now,
            "frontierPath": new_fp or meta.get("frontierPath"),
            "targetedRerun": True,
        }

    iso_cp = {
        "version": 3,
        "testedCodeSha": "40574b7263c0834da51404d25cfc1f375ab0db36",
        "startedAt": now,
        "updatedAt": now,
        "terminal": {},
        "retryQueue": iso_rq,
        "inProgress": {},
        "attempts": {lid: iso_rq[lid]["attempts"] for lid in ids},
        "stats": {
            "processed": 0,
            "terminal": 0,
            "hot": 0,
            "pub": 0,
            "review": 0,
            "retry": 0,
            "tech": 0,
            "outOfScope": 0,
            "errors": 0,
        },
    }
    (OUT / "checkpoint.json").write_text(json.dumps(iso_cp, indent=2, ensure_ascii=False))
    (OUT / "ids.json").write_text(json.dumps({"ids": ids}, indent=2))
    (OUT / "baseline.json").write_text(
        json.dumps(
            {
                "prodCheckpointSha": sha(PROD_CP),
                "dbSha": sha(DB),
                "dbPath": str(DB),
                "n": len(ids),
                "frozenAt": now,
                "runtimeSha": "40574b7263c0834da51404d25cfc1f375ab0db36",
            },
            indent=2,
        )
    )
    print(json.dumps({"out": str(OUT), "n": len(ids), "ids": ids, "prodSha": sha(PROD_CP), "dbSha": sha(DB)}, indent=2))


if __name__ == "__main__":
    main()
