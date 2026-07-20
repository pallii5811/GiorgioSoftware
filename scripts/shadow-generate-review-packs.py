#!/usr/bin/env python3
"""Generate shadow human-review priority packs from quarantined shadow DB (no human marks)."""
from __future__ import annotations

import csv
import json
import os
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = Path(os.environ.get("SHADOW_DB_PATH", ROOT / "data/shadow/db/giorgio-shadow-20260718.db"))
OUT = ROOT / "docs/human-review/shadow"
OUT.mkdir(parents=True, exist_ok=True)

VERDICT_RE = re.compile(r"\[V:(HOT|PUB|REV)\]", re.I)
HIST_RE = re.compile(r"\[SHADOW_HIST_VERDICT:([A-Z]+)\]")


def verdict(ev: str | None) -> str:
    if not ev:
        return "?"
    m = VERDICT_RE.search(ev)
    if not m:
        return "?"
    return {"HOT": "HOT", "PUB": "PUBLISHED", "REV": "REVIEW"}.get(m.group(1).upper(), "?")


def hist(ev: str | None) -> str:
    if not ev:
        return "?"
    m = HIST_RE.search(ev)
    return m.group(1) if m else verdict(ev)


FIELDS = [
    "id",
    "region",
    "province_or_city",
    "companyName",
    "website",
    "old_verdict",
    "new_status",
    "leadScore",
    "stratum",
    "reviewer",
    "reviewed_at",
    "entity_correct",
    "official_website_correct",
    "identity_correct",
    "source_correct",
    "verdict_correct",
    "commercial_value_real",
    "false_positive",
    "false_negative",
    "critical_contamination",
    "notes",
    "corrected_value",
]


def html_table(title: str, rows: list[dict]) -> str:
    th = "".join(f"<th>{f}</th>" for f in FIELDS)
    body = []
    for r in rows:
        tds = "".join(f"<td>{(r.get(f) or '')}</td>" for f in FIELDS)
        body.append(f"<tr>{tds}</tr>")
    return f"""<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>{title}</title>
<style>body{{font-family:system-ui;margin:1rem}}table{{border-collapse:collapse;width:100%;font-size:11px}}
th,td{{border:1px solid #ccc;padding:3px}}th{{background:#eee}}.b{{background:#fff3cd;padding:10px;margin-bottom:1rem}}</style>
</head><body>
<div class="b"><strong>Record revisionati da umano: 0</strong> — reviewer non precompilato. Shadow quarantine only.</div>
<h1>{title}</h1>
<table><thead><tr>{th}</tr></thead><tbody>
{''.join(body)}
</tbody></table></body></html>"""


def sample_sanita(region: str, n: int = 100) -> list[dict]:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    rows = c.execute(
        "SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=? ORDER BY leadScore DESC",
        (region,),
    ).fetchall()
    c.close()
    buckets = {"HOT": [], "PUBLISHED": [], "REVIEW": [], "OTHER": []}
    for r in rows:
        v = hist(r["evidence"])
        buckets.get(v, buckets["OTHER"]).append(r)
    quotas = [("HOT", 35), ("PUBLISHED", 25), ("REVIEW", 30), ("OTHER", 10)]
    out = []
    for key, q in quotas:
        for r in buckets[key][:q]:
            out.append(
                {
                    "id": r["id"],
                    "region": region,
                    "province_or_city": r["city"] or "",
                    "companyName": r["companyName"],
                    "website": r["website"] or "",
                    "old_verdict": hist(r["evidence"]),
                    "new_status": "RESCAN_REQUIRED",
                    "leadScore": r["leadScore"],
                    "stratum": hist(r["evidence"]),
                    "reviewer": "",
                    "reviewed_at": "",
                    "entity_correct": "",
                    "official_website_correct": "",
                    "identity_correct": "",
                    "source_correct": "",
                    "verdict_correct": "",
                    "commercial_value_real": "",
                    "false_positive": "",
                    "false_negative": "",
                    "critical_contamination": "",
                    "notes": "",
                    "corrected_value": "",
                }
            )
    return out[:n]


def sample_gare(region: str, n: int = 100) -> list[dict]:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    rows = c.execute(
        "SELECT * FROM Lead WHERE type='TENDER' AND region=? ORDER BY leadScore DESC LIMIT ?",
        (region, n),
    ).fetchall()
    c.close()
    out = []
    for i, r in enumerate(rows):
        out.append(
            {
                "id": r["id"],
                "region": region,
                "province_or_city": r["city"] or "",
                "companyName": r["companyName"],
                "website": r["website"] or "",
                "old_verdict": r["category"] or "TENDER",
                "new_status": "SHADOW_UNVERIFIED",
                "leadScore": r["leadScore"],
                "stratum": "HIGH" if i < 30 else "MEDIUM" if i < 60 else "OTHER",
                "reviewer": "",
                "reviewed_at": "",
                "entity_correct": "",
                "official_website_correct": "",
                "identity_correct": "",
                "source_correct": "",
                "verdict_correct": "",
                "commercial_value_real": "",
                "false_positive": "",
                "false_negative": "",
                "critical_contamination": "",
                "notes": "",
                "corrected_value": "",
            }
        )
    return out


def write_pack(prefix: str, title: str, rows: list[dict]) -> None:
    csv_path = OUT / f"{prefix}.csv"
    html_path = OUT / f"{prefix}.html"
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    html_path.write_text(html_table(title, rows), encoding="utf-8")
    print(prefix, len(rows))


summary = {"humanReviewed": 0, "packs": []}
for region in ("Campania", "Veneto"):
    rows = sample_sanita(region)
    write_pack(f"sanita-{region.lower()}-priority", f"Shadow Sanità {region} priority", rows)
    summary["packs"].append({"file": f"sanita-{region.lower()}-priority", "rows": len(rows), "humanReviewed": 0})
    grows = sample_gare(region)
    write_pack(f"gare-{region.lower()}-priority", f"Shadow Gare {region} priority", grows)
    summary["packs"].append({"file": f"gare-{region.lower()}-priority", "rows": len(grows), "humanReviewed": 0})

(OUT / "SUMMARY.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print("humanReviewed=0")
