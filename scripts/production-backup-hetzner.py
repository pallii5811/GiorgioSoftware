#!/usr/bin/env python3
"""Timestamped live SQLite backup + integrity + restore test + shadow copy."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone

SRC = "/opt/leadsniper/prisma/dev.db"
BAK_DIR = "/opt/leadsniper/backups"
SHADOW_DIR = "/opt/leadsniper/shadow"


def main() -> None:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    os.makedirs(BAK_DIR, exist_ok=True)
    os.makedirs(SHADOW_DIR, exist_ok=True)
    bak = os.path.join(BAK_DIR, f"giorgio-live-{ts}.db")
    meta_path = os.path.join(BAK_DIR, f"giorgio-live-{ts}.meta.json")
    env_names = os.path.join(BAK_DIR, f"env-names-{ts}.txt")
    code_snap = os.path.join(BAK_DIR, f"code-tree-{ts}.txt")
    restore = f"/tmp/giorgio-restore-test-{ts}.db"
    shadow = os.path.join(SHADOW_DIR, f"giorgio-shadow-{ts}.db")

    src = sqlite3.connect(SRC)
    dst = sqlite3.connect(bak)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    for suf in ("-wal", "-shm"):
        p = SRC + suf
        if os.path.exists(p):
            shutil.copy2(p, bak + suf)

    size = os.path.getsize(bak)
    h = hashlib.sha256()
    with open(bak, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)

    c = sqlite3.connect(f"file:{bak}?mode=ro", uri=True)
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
    cols = {r[1] for r in cur.execute("PRAGMA table_info(Lead)")}
    crm = {}
    if "status" in cols:
        crm = dict(
            cur.execute(
                "SELECT COALESCE(status,'NULL'), COUNT(*) FROM Lead GROUP BY status"
            ).fetchall()
        )
    unscanned = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND lastScannedAt IS NULL"
    ).fetchone()[0]
    c.close()

    build_id = None
    bid = "/opt/leadsniper/.next/BUILD_ID"
    if os.path.exists(bid):
        build_id = open(bid, encoding="utf-8").read().strip()

    meta = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ts": ts,
        "source": SRC,
        "backup": bak,
        "shadow": shadow,
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
        "healthcareUnscanned": unscanned,
        "crmByStatus": crm,
        "buildId": build_id,
        "pm2": "leadsniper-ui online (queried separately)",
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    shutil.copy2(bak, restore)
    r = sqlite3.connect(f"file:{restore}?mode=ro", uri=True)
    r_ok = r.execute("PRAGMA integrity_check").fetchone()[0]
    r_total = r.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
    r.close()
    restore_ok = r_ok == "ok" and r_total == total and integrity == "ok"
    meta["restoreTest"] = {
        "path": restore,
        "integrity": r_ok,
        "count": r_total,
        "match": r_total == total,
        "ok": restore_ok,
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    if not restore_ok:
        raise SystemExit("STOP-SHIP: restore test failed")

    shutil.copy2(bak, shadow)

    # env names only
    lines = []
    for name in [
        ".env",
        ".env.local",
        ".env.production",
        ".env.production.local",
    ]:
        path = os.path.join("/opt/leadsniper", name)
        if not os.path.isfile(path):
            continue
        lines.append(f"=== {name} ===")
        with open(path, encoding="utf-8", errors="ignore") as f:
            for raw in f:
                raw = raw.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                lines.append(raw.split("=", 1)[0])
    with open(env_names, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    with open(code_snap, "w", encoding="utf-8") as f:
        f.write(f"buildId={build_id}\n")
        f.write(f"dbMtime={os.path.getmtime(SRC)}\n")

    print(json.dumps(meta, indent=2))
    print(f"BACKUP_OK ts={ts}")


if __name__ == "__main__":
    main()
