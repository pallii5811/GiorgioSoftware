import sqlite3

c = sqlite3.connect("/opt/leadsniper/prisma/dev.db")
hc = "type='HEALTHCARE'"
total = c.execute(f"select count(*) from Lead where {hc}").fetchone()[0]
scanned = c.execute(
    f"select count(*) from Lead where {hc} and lastScannedAt is not null"
).fetchone()[0]
hot = c.execute(
    f"select count(*) from Lead where {hc} and evidence like '%[V:HOT]%'"
).fetchone()[0]
print(
    {
        "healthcare": total,
        "scanned": scanned,
        "pending": total - scanned,
        "hot_in_evidence": hot,
    }
)
print(
    "status_top",
    c.execute(
        f"select status, count(*) from Lead where {hc} group by status order by 2 desc limit 20"
    ).fetchall(),
)
print(
    "pini",
    c.execute(
        "select companyName, lastScannedAt, status, substr(evidence,1,120) from Lead where companyName like '%Villa Dei Pini%'"
    ).fetchone(),
)
