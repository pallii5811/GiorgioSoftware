#!/usr/bin/env python3
"""Local verify of rerun shadow DB post-quarantine. No network."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

DB = Path("data/shadow/db/giorgio-shadow-20260718-rerun.db")
BAK = Path("data/shadow/db/giorgio-live-backup-20260718.db")
EXPECTED = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main() -> None:
    assert BAK.exists() and sha(BAK) == EXPECTED
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    out = {
        "db": str(DB),
        "leadTotal": c.execute("SELECT COUNT(*) FROM Lead").fetchone()[0],
        "hot": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:HOT]%'"
        ).fetchone()[0],
        "pub": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:PUB]%'"
        ).fetchone()[0],
        "rev": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:REV]%'"
        ).fetchone()[0],
        "quarantineMarkers": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%LEGACY:RESCAN_REQUIRED%'"
        ).fetchone()[0],
        "shadowHist": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%SHADOW_HIST_VERDICT%'"
        ).fetchone()[0],
        "campania": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Campania'"
        ).fetchone()[0],
        "veneto": c.execute(
            "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Veneto'"
        ).fetchone()[0],
        "maxLastScannedAt": c.execute(
            "SELECT max(lastScannedAt) FROM Lead"
        ).fetchone()[0],
        "maxUpdatedAt": c.execute("SELECT max(updatedAt) FROM Lead").fetchone()[0],
        "backupShaStill": sha(BAK),
    }
    c.close()
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
