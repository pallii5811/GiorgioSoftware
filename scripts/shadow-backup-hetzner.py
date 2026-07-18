#!/usr/bin/env python3
"""Consistent SQLite backup of live LeadSniper DB — read-only on source."""
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone

SRC = "/opt/leadsniper/prisma/dev.db"
BAK_DIR = "/opt/leadsniper/backups"
BAK = os.path.join(BAK_DIR, "giorgio-live-20260718.db")
META = os.path.join(BAK_DIR, "giorgio-live-20260718.meta.json")


def main() -> None:
    os.makedirs(BAK_DIR, exist_ok=True)
    src = sqlite3.connect(SRC)
    dst = sqlite3.connect(BAK)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    size = os.path.getsize(BAK)
    h = hashlib.sha256()
    with open(BAK, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)

    c = sqlite3.connect(f"file:{BAK}?mode=ro", uri=True)
    cur = c.cursor()
    integrity = cur.execute("PRAGMA integrity_check").fetchone()[0]
    tables = cur.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
    ).fetchone()[0]
    total = cur.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
    by_type = dict(cur.execute("SELECT type, COUNT(*) FROM Lead GROUP BY type").fetchall())
    hot = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:HOT]%'"
    ).fetchone()[0]
    pub = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:PUB]%'"
    ).fetchone()[0]
    rev = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:REV]%'"
    ).fetchone()[0]
    camp = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Campania'"
    ).fetchone()[0]
    ven = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Veneto'"
    ).fetchone()[0]
    gare = cur.execute("SELECT COUNT(*) FROM Lead WHERE type='TENDER'").fetchone()[0]
    max_ts = cur.execute("SELECT MAX(lastScannedAt) FROM Lead").fetchone()[0]
    c.close()

    meta = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": SRC,
        "backup": BAK,
        "sizeBytes": size,
        "sha256": h.hexdigest(),
        "integrity": integrity,
        "tables": tables,
        "leadTotal": total,
        "byType": by_type,
        "hotToken": hot,
        "pubToken": pub,
        "revToken": rev,
        "sanitaCampania": camp,
        "sanitaVeneto": ven,
        "gare": gare,
        "maxLastScannedAt": max_ts,
        "note": "Backup only — live DB not opened for write by this script",
    }
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
