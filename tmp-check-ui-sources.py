import json, urllib.request, sqlite3
from pathlib import Path

# local API on server
for url in [
    "http://127.0.0.1:3000/api/sanita?includeAll=1",
    "http://127.0.0.1:3000/api/sanita/archive-revalidation",
    "http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=run",
]:
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            raw = r.read()
        j = json.loads(raw)
        if "data" in j:
            print(url.split("3000")[-1], "data", len(j.get("data") or []), "meta", {k: j.get("meta", {}).get(k) for k in ("dbTotal", "actionableCount", "totalReturned")})
        else:
            keys = list(j.keys())[:12] if isinstance(j, dict) else type(j)
            print(url.split("3000")[-1], "keys", keys)
            if isinstance(j, dict):
                for k in ("terminalCompleted", "targetTotal", "archiveTotal", "total", "certifiedCurrentRun", "success"):
                    if k in j:
                        print(" ", k, j[k])
    except Exception as e:
        print(url.split("3000")[-1], "ERR", e)

c = sqlite3.connect("/opt/leadsniper/prisma/dev.db")
print("db", c.execute("select count(*) from Lead").fetchone()[0], "hc", c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0])
