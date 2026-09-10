import json, urllib.request, sqlite3, collections

# status / evidence signals on restored DB
c = sqlite3.connect("/opt/leadsniper/prisma/dev.db")
rows = c.execute(
    "select status, substr(evidence,1,80), lastScannedAt is not null from Lead where type='HEALTHCARE' limit 5"
).fetchall()
print("sample", rows)
st = c.execute(
    "select status, count(*) from Lead where type='HEALTHCARE' group by status order by 2 desc"
).fetchall()
print("status", st)
# token counts in evidence
for tok in ["[V:HOT]", "[V:PUBLISHED]", "HOT_VERIFIED", "PUBLISHED_CURRENT", "PUBLISHED", "processingState", "businessVerdict"]:
    n = c.execute(
        "select count(*) from Lead where type='HEALTHCARE' and evidence like ?",
        (f"%{tok}%",),
    ).fetchone()[0]
    print("tok", tok, n)

# API as UI calls it
with urllib.request.urlopen(
    "http://127.0.0.1:3000/api/sanita?includePending=1&includeAll=1", timeout=60
) as r:
    j = json.loads(r.read())
data = j.get("data") or []
print("api_n", len(data), "actionable", (j.get("meta") or {}).get("actionableCount"))
# how many have semantic actionable
act = sum(1 for x in data if (x.get("semantic") or {}).get("actionable") or x.get("_actionable"))
print("semantic_actionable", act)
# outcome-ish from status field on payload
ctr = collections.Counter((x.get("status") or "?") for x in data)
print("api_status_top", ctr.most_common(15))
# check presentSanita fields
if data:
    x = data[0]
    print("keys0", sorted(x.keys())[:40])
    print("sem0", x.get("semantic"))
