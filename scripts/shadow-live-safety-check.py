#!/usr/bin/env python3
"""Read-only live safety + timestamp compare vs immutable backup. No PII."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from datetime import datetime, timezone

LIVE = "/opt/leadsniper/prisma/dev.db"
BAK = "/opt/leadsniper/backups/giorgio-live-20260718.db"
EXPECTED = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"


def file_sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def open_ro(path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def main() -> None:
    bak_sha = file_sha(BAK)
    live_sha = file_sha(LIVE)
    assert bak_sha.lower() == EXPECTED.lower(), f"backup mutated: {bak_sha}"

    b = open_ro(BAK)
    l = open_ro(LIVE)

    def maxes(c: sqlite3.Connection):
        return c.execute(
            "SELECT max(createdAt), max(updatedAt), max(lastScannedAt), max(id) FROM Lead"
        ).fetchone()

    q = (
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%LEGACY:RESCAN_REQUIRED%' "
        "OR notes LIKE '%LEGACY:RESCAN_REQUIRED%'"
    )
    hist = (
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%SHADOW_HIST_VERDICT%' "
        "OR notes LIKE '%SHADOW_HIST_VERDICT%'"
    )
    ev = "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[EV_V:%'"

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "backupSha256": bak_sha,
        "liveSha256": live_sha,
        "backupImmutable": True,
        "leadTotalBackup": b.execute("SELECT COUNT(*) FROM Lead").fetchone()[0],
        "leadTotalLive": l.execute("SELECT COUNT(*) FROM Lead").fetchone()[0],
        "hotBackup": b.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:HOT]%'"
        ).fetchone()[0],
        "hotLive": l.execute(
            "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:HOT]%'"
        ).fetchone()[0],
        "liveQuarantineMarkers": l.execute(q).fetchone()[0],
        "liveShadowHistMarkers": l.execute(hist).fetchone()[0],
        "liveEvidenceVersionMarkers": l.execute(ev).fetchone()[0],
        "backupMaxes": {
            "createdAt": maxes(b)[0],
            "updatedAt": maxes(b)[1],
            "lastScannedAt": maxes(b)[2],
            "maxIdHash": hashlib.sha256(str(maxes(b)[3]).encode()).hexdigest()[:12],
        },
        "liveMaxes": {
            "createdAt": maxes(l)[0],
            "updatedAt": maxes(l)[1],
            "lastScannedAt": maxes(l)[2],
            "maxIdHash": hashlib.sha256(str(maxes(l)[3]).encode()).hexdigest()[:12],
        },
        "processProbe": {
            "shadowTmp": subprocess.getoutput(
                "ls -la /tmp/*shadow* 2>/dev/null | head -20 || true"
            ),
            "orphanShadow": subprocess.getoutput(
                "ps aux | grep -E '[s]hadow-|[q]uarantine|[l]egacy-audit' | head -20 || true"
            ),
            "liveDbHolders": subprocess.getoutput(
                "lsof /opt/leadsniper/prisma/dev.db 2>/dev/null | head -15 || true"
            ),
        },
    }
    b.close()
    l.close()
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
