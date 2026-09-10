#!/usr/bin/env python3
import json, sqlite3
c = sqlite3.connect("file:/opt/leadsniper/prisma/dev.db?mode=ro", uri=True)
crm = dict(c.execute("SELECT COALESCE(status,'NULL'), COUNT(*) FROM Lead GROUP BY status"))
print(json.dumps({
    "crmByStatus": crm,
    "hc": c.execute("SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE'").fetchone()[0],
    "pub": c.execute("SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND evidence LIKE '%[V:PUB]%'").fetchone()[0],
    "crmLoss": 0 if all(k == "NEW" for k in crm) or set(crm.keys()) <= {"NEW", "NULL"} else "check",
}, indent=2))
