import hashlib
import json
import os
import sqlite3

bak = "data/shadow/db/giorgio-live-backup-20260718.db"
shadow = "data/shadow/db/giorgio-shadow-20260718.db"
assert os.path.exists(bak), "backup missing"
if not os.path.exists(shadow):
    import shutil
    shutil.copy2(bak, shadow)

def check(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = c.cursor()
    integrity = cur.execute("PRAGMA integrity_check").fetchone()[0]
    total = cur.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
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
    c.close()
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return {
        "path": path,
        "sizeBytes": os.path.getsize(path),
        "sha256": h.hexdigest(),
        "integrity": integrity,
        "leadTotal": total,
        "hot": hot,
        "published": pub,
        "review": rev,
        "sanitaCampania": camp,
        "sanitaVeneto": ven,
        "gare": gare,
    }

out = {"backup": check(bak), "shadow": check(shadow)}
out["sha256Match"] = out["backup"]["sha256"] == out["shadow"]["sha256"]
out["expectedLiveSha256"] = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"
out["matchesHetznerBackup"] = out["backup"]["sha256"] == out["expectedLiveSha256"]
print(json.dumps(out, indent=2))
with open("docs/shadow/pre-shadow-row-counts.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)
