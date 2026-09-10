import sqlite3, re
from datetime import datetime, timezone

c = sqlite3.connect("/opt/leadsniper/prisma/dev.db")
rows = c.execute(
    "select evidence, policyExpiry from Lead where type='HEALTHCARE'"
).fetchall()


def token(ev):
    if not ev:
        return None
    m = re.search(r"\[V:(HOT|PUB|REVIEW)\]", ev)
    return m.group(1) if m else None


def fut(raw):
    if not raw:
        return None
    try:
        d = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        try:
            d = datetime.strptime(str(raw)[:10], "%Y-%m-%d")
        except Exception:
            return None
    day = d.date()
    today = datetime.now(timezone.utc).date()
    if day > today:
        return True
    if day < today:
        return False
    return True


pub_valid = pub_exp = date_unk = hot = 0
for ev, exp in rows:
    t = token(ev)
    if t == "HOT":
        hot += 1
    elif t == "PUB":
        f = fut(exp)
        if f is True:
            pub_valid += 1
        elif f is False:
            pub_exp += 1
        else:
            date_unk += 1
print(
    "PUB_VALID",
    pub_valid,
    "PUB_EXP",
    pub_exp,
    "DATE_UNK",
    date_unk,
    "HOT",
    hot,
    "SUM",
    pub_valid + pub_exp + date_unk + hot,
)
