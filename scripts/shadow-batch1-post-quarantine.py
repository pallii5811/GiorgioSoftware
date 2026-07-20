#!/usr/bin/env python3
"""Post-quarantine gate checks on shadow rerun DB."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

DB = Path("data/shadow/db/giorgio-shadow-20260718-rerun.db")
BAK = Path("data/shadow/db/giorgio-live-backup-20260718.db")
EXPECTED = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"
OUT = Path("docs/shadow/batch1/post-quarantine-check.json")


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def main() -> None:
    assert BAK.exists() and sha(BAK) == EXPECTED
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

    def n(q: str, *a):
        return c.execute(q, a).fetchone()[0]

    out = {
        "backupShaImmutable": sha(BAK),
        "leadTotal": n("SELECT COUNT(*) FROM Lead"),
        "sanita": n("SELECT COUNT(*) FROM Lead WHERE type=?", "HEALTHCARE"),
        "gare": n("SELECT COUNT(*) FROM Lead WHERE type=?", "TENDER"),
        "hotToken": n("SELECT COUNT(*) FROM Lead WHERE evidence LIKE ?", "%[V:HOT]%"),
        "pubToken": n("SELECT COUNT(*) FROM Lead WHERE evidence LIKE ?", "%[V:PUB]%"),
        "revToken": n("SELECT COUNT(*) FROM Lead WHERE evidence LIKE ?", "%[V:REV]%"),
        "sanitaQuarantine": n(
            "SELECT COUNT(*) FROM Lead WHERE type=? AND evidence LIKE ?",
            "HEALTHCARE",
            "%LEGACY:RESCAN_REQUIRED%",
        ),
        "gareQuarantine": n(
            "SELECT COUNT(*) FROM Lead WHERE type=? AND evidence LIKE ?",
            "TENDER",
            "%LEGACY:RESCAN_REQUIRED%",
        ),
        "shadowHist": n(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE ?", "%SHADOW_HIST_VERDICT%"
        ),
        "legacyCurrent": n(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE ?", "%LEGACY:CURRENT%"
        ),
        # actionable = HOT/PUB with CURRENT evidence version — must be 0 after quarantine
        "legacyActionable": n(
            """
            SELECT COUNT(*) FROM Lead
            WHERE type='HEALTHCARE'
              AND (evidence LIKE '%[V:HOT]%' OR evidence LIKE '%[V:PUB]%')
              AND evidence LIKE '%LEGACY:CURRENT%'
              AND evidence NOT LIKE '%LEGACY:RESCAN_REQUIRED%'
              AND evidence NOT LIKE '%LEGACY:LEGACY_UNVERIFIED%'
            """
        ),
        "deletedVsBackup": n("SELECT COUNT(*) FROM Lead") - 1237,
    }
    gates = {
        "leadTotal_1237": out["leadTotal"] == 1237,
        "sanita_877": out["sanita"] == 877,
        "gare_360": out["gare"] == 360,
        "sanitaQuarantine_877": out["sanitaQuarantine"] == 877,
        "gareQuarantine_0": out["gareQuarantine"] == 0,
        "legacyActionable_0": out["legacyActionable"] == 0,
        "noDeletes": out["deletedVsBackup"] == 0,
        "histPreserved": out["shadowHist"] == 877,
        "noCurrentInvented": out["legacyCurrent"] == 0,
    }
    out["gates"] = gates
    out["pass"] = all(gates.values())
    c.close()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps(out, indent=2))
    raise SystemExit(0 if out["pass"] else 1)


if __name__ == "__main__":
    main()
