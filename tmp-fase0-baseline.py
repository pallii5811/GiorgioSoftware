#!/usr/bin/env python3
"""FASE0 signed baseline — freeze invariants."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

PROD_CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
TARGET = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
APP = Path("/opt/leadsniper-revalidate/app")


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


def main() -> None:
    cp = json.loads(PROD_CP.read_text())
    tcp = json.loads((TARGET / "checkpoint.json").read_text())
    base_old = {}
    if (TARGET / "baseline.json").exists():
        base_old = json.loads((TARGET / "baseline.json").read_text())

    db_path = base_old.get("dbPath")
    for cand in [
        db_path,
        "/opt/leadsniper-revalidate/shadow-revalidate.db",
        "/opt/leadsniper/prisma/dev.db",
    ]:
        if cand and Path(cand).exists():
            db_path = cand
            break

    refs = {}
    try:
        con = sqlite3.connect(db_path)
        for needle in ("Villa Angela", "Villa Dei Pini", "Malzoni", "Villa dei Fiori"):
            rows = con.execute(
                "SELECT id, companyName, COALESCE(processingState,''), COALESCE(businessVerdict,'') "
                "FROM Lead WHERE companyName LIKE ? LIMIT 8",
                (f"%{needle}%",),
            ).fetchall()
            refs[needle] = [
                {"id": r[0], "name": r[1], "processingState": r[2], "businessVerdict": r[3]}
                for r in rows
            ]
        con.close()
    except Exception as e:
        refs = {"error": str(e)}

    term = cp.get("terminal") or {}
    retry = cp.get("retryQueue") or {}
    ip = cp.get("inProgress") or {}
    c = Counter()
    for v in term.values():
        st = v.get("processingState") if isinstance(v, dict) else str(v)
        c[st] += 1

    # checkpoint states for known ref ids
    ref_cp = {}
    for group, rows in (refs.items() if isinstance(refs, dict) else []):
        if group == "error":
            continue
        for r in rows:
            lid = r["id"]
            if lid in term:
                ref_cp[lid] = {"bucket": "terminal", **(term[lid] if isinstance(term[lid], dict) else {"v": term[lid]})}
            elif lid in retry:
                ref_cp[lid] = {"bucket": "retry", **retry[lid]}
            elif lid in ip:
                ref_cp[lid] = {"bucket": "inProgress", **ip[lid]}
            else:
                ref_cp[lid] = {"bucket": "absent"}

    release = (APP / "RELEASE_SHA").read_text().strip() if (APP / "RELEASE_SHA").exists() else None

    baseline = {
        "signedAt": datetime.now(timezone.utc).isoformat(),
        "phase": "FASE0_FREEZE",
        "dbPath": db_path,
        "dbSha": sha(db_path),
        "prodCheckpointPath": str(PROD_CP),
        "prodCheckpointSha": sha(PROD_CP),
        "prodTerminal": len(term),
        "prodRetry": len(retry),
        "prodInProgress": list(ip.keys()),
        "prodTerminalCountByState": dict(c),
        "refsDb": refs,
        "refsCheckpoint": ref_cp,
        "gitCommitExpected": "9c1f958c69be809c752d435fc2615f153067caff",
        "runtimeSha": release,
        "targeted": {
            "terminal": len(tcp.get("terminal") or {}),
            "retry": len(tcp.get("retryQueue") or {}),
            "inProgress": list((tcp.get("inProgress") or {}).keys()),
            "attempts": tcp.get("attempts") or {},
        },
        "giorgioActive": subprocess.getoutput("systemctl is-active giorgio-revalidate"),
    }
    (TARGET / "FASE0_BASELINE.json").write_text(json.dumps(baseline, indent=2, ensure_ascii=False))
    signed = {
        **base_old,
        "dbPath": db_path,
        "dbSha": baseline["dbSha"],
        "prodCheckpointSha": baseline["prodCheckpointSha"],
        "fase0SignedAt": baseline["signedAt"],
        "fase0": baseline,
    }
    (TARGET / "baseline.json").write_text(json.dumps(signed, indent=2))
    print(json.dumps(baseline, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
