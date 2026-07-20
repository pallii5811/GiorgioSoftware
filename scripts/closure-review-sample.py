#!/usr/bin/env python3
"""30 historical REVIEW pack for gold review index."""
import csv
import json
import sqlite3
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data/shadow/db/giorgio-shadow-closure-20260719.db"
OUT = ROOT / "docs/human-review/review-sample-final"

c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
c.row_factory = sqlite3.Row
rows = c.execute(
    """
    SELECT id, companyName, region, city, category, website, evidence
    FROM Lead WHERE type='HEALTHCARE' AND evidence LIKE '%[V:REV]%'
    ORDER BY region, companyName LIMIT 30
    """
).fetchall()
c.close()
OUT.mkdir(parents=True, exist_ok=True)
data = []
for r in rows:
    data.append(
        {
            "leadId": r["id"],
            "companyName": r["companyName"],
            "region": r["region"],
            "city": r["city"],
            "category": r["category"],
            "website": r["website"],
            "verdict": "REVIEW",
            "evidenceExcerpt": (r["evidence"] or "")[:400],
            "reviewer": "",
            "reviewed_at": "",
            "notes": "",
        }
    )
cols = list(data[0].keys()) if data else []
with (OUT / "review-sample.csv").open("w", encoding="utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(data)
th = "".join(f"<th>{escape(x)}</th>" for x in cols)
body = "".join(
    "<tr>" + "".join(f"<td>{escape(str(r.get(c,'') or '')[:300])}</td>" for c in cols) + "</tr>"
    for r in data
)
(OUT / "review-sample.html").write_text(
    f"""<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>REVIEW sample 30</title></head>
<body><h1>REVIEW sample (30)</h1><p>humanReviewed=0</p>
<table border="1"><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></body></html>""",
    encoding="utf-8",
)
(OUT / "summary.json").write_text(
    json.dumps({"humanReviewed": 0, "n": len(data)}, indent=2), encoding="utf-8"
)
print("review sample", len(data))
