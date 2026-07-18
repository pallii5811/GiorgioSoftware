import hashlib
import json
import sqlite3

live_path = "/opt/leadsniper/prisma/dev.db"
bak_path = "/opt/leadsniper/backups/giorgio-live-20260718.db"
meta = json.load(open("/opt/leadsniper/backups/giorgio-live-20260718.meta.json"))

live_hash = hashlib.sha256(open(live_path, "rb").read()).hexdigest()
bak_hash = hashlib.sha256(open(bak_path, "rb").read()).hexdigest()

def counts(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = c.cursor()
    total = cur.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
    hot = cur.execute("SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:HOT]%'").fetchone()[0]
    max_ts = cur.execute("SELECT MAX(lastScannedAt) FROM Lead").fetchone()[0]
    # quarantine marker must NOT exist on live
    q = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%LEGACY:RESCAN_REQUIRED%'"
    ).fetchone()[0]
    c.close()
    return {"total": total, "hot": hot, "maxLastScannedAt": max_ts, "quarantineMarkers": q}

out = {
    "liveSha256Now": live_hash,
    "backupFileSha256": bak_hash,
    "backupMetaSha256": meta["sha256"],
    "backupFileUnchanged": bak_hash == meta["sha256"],
    "liveDriftedSinceBackup": live_hash != meta["sha256"],
    "liveCounts": counts(live_path),
    "backupCounts": counts(bak_path),
    "interpretation": (
        "Backup file immutable and matches meta. Live hash drift is expected if production "
        "continues writing; quarantine markers on live must be 0."
    ),
}
print(json.dumps(out, indent=2))
