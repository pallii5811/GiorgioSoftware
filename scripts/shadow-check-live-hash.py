import hashlib
import json

live = hashlib.sha256(open("/opt/leadsniper/prisma/dev.db", "rb").read()).hexdigest()
meta = json.load(open("/opt/leadsniper/backups/giorgio-live-20260718.meta.json"))
print(json.dumps({
    "liveSha256": live,
    "backupSha256": meta["sha256"],
    "unchangedVsBackup": live == meta["sha256"],
    "leadTotalBackup": meta["leadTotal"],
}, indent=2))
