#!/usr/bin/env python3
"""Freeze immutable PUBLISHED baseline (120) from snapshot backup — PII stays gitignored."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BAK = Path("data/shadow/db/giorgio-live-backup-20260718.db")
EXPECTED = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"
OUT_JSONL = Path("data/baseline/published-live-v1.jsonl")
OUT_REPORT = Path("docs/baseline/published-live-v1-report.md")
OUT_IDS = Path("docs/baseline/published-live-v1-ids.json")


def sha(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def classify(row) -> str:
    ev = row["evidence"] or ""
    obsolete = bool(row["policyExpiry"]) and (
        # rough: if expiry string year before 2024 treat expired; also evidence scaduta
        False
    )
    if re.search(r"scaduta|obsolete|policyObsolete", ev, re.I):
        return "CONFIRMED_EXPIRED"
    if row["policyExpiry"]:
        try:
            # Prisma may store as ms epoch or ISO
            pe = row["policyExpiry"]
            if isinstance(pe, (int, float)) or (isinstance(pe, str) and pe.isdigit()):
                ts = int(pe)
                if ts > 1e12:
                    ts //= 1000
                from datetime import datetime

                if datetime.utcfromtimestamp(ts).year < 2024:
                    return "CONFIRMED_EXPIRED"
            elif isinstance(pe, str) and re.match(r"\d{4}-", pe):
                if int(pe[:4]) < 2024:
                    return "CONFIRMED_EXPIRED"
                return "CONFIRMED_VALID"
        except Exception:
            pass
    if not row["policyCompany"] and not row["policyNumber"]:
        return "CONFIRMED_INCOMPLETE_PUBLICATION"
    if row["policyCompany"] and not row["policyExpiry"]:
        return "CONFIRMED_DATE_UNKNOWN"
    if row["policyCompany"] and row["policyNumber"]:
        return "CONFIRMED_VALID"
    return "TECHNICAL_REVALIDATION_REQUIRED"


def main() -> None:
    assert BAK.exists(), "immutable backup missing"
    assert sha(BAK) == EXPECTED, "backup SHA mismatch — refuse baseline"
    c = sqlite3.connect(f"file:{BAK}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    rows = c.execute(
        """
        SELECT id, companyName, city, region, website, category, evidence,
               policyCompany, policyNumber, policyExpiry, policyMassimale,
               policyFound, leadScore, pagesVisited, lastScannedAt
        FROM Lead
        WHERE type='HEALTHCARE' AND evidence LIKE '%[V:PUB]%'
        ORDER BY region, companyName
        """
    ).fetchall()
    c.close()
    assert len(rows) == 120, f"expected 120 PUBLISHED, got {len(rows)}"

    OUT_JSONL.parent.mkdir(parents=True, exist_ok=True)
    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)

    classes = {}
    ids = []
    with OUT_JSONL.open("w", encoding="utf-8") as f:
        for r in rows:
            cls = classify(r)
            classes[cls] = classes.get(cls, 0) + 1
            ids.append(r["id"])
            rec = {
                "leadId": r["id"],
                "companyName": r["companyName"],
                "city": r["city"],
                "region": r["region"],
                "website": r["website"],
                "category": r["category"],
                "evidenceUrlHint": None,
                "evidenceType": "snapshot_evidence_text",
                "evidenceExcerpt": (r["evidence"] or "")[:500],
                "policyCompany": r["policyCompany"],
                "policyNumber": r["policyNumber"],
                "policyStart": None,
                "policyExpiry": str(r["policyExpiry"]) if r["policyExpiry"] else None,
                "documentDate": None,
                "historicalVerdict": "PUBLISHED",
                "documentHash": None,
                "baselineClass": cls,
                "snapshotSha256": EXPECTED,
                "frozenAt": datetime.now(timezone.utc).isoformat(),
            }
            # extract first http URL from evidence if present
            m = re.search(r"https?://[^\s\]\|]+", r["evidence"] or "")
            if m:
                rec["evidenceUrlHint"] = m.group(0)[:300]
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    OUT_IDS.write_text(json.dumps({"count": 120, "ids": ids, "snapshotSha256": EXPECTED}, indent=2), encoding="utf-8")
    report = f"""# PUBLISHED live baseline v1

**Frozen from:** immutable snapshot SHA `{EXPECTED}`  
**Count:** 120  
**Frozen at:** {datetime.now(timezone.utc).isoformat()}

## Classification (heuristic from snapshot fields — human review still required)

| Class | Count |
|-------|------:|
""" + "\n".join(f"| `{k}` | {v} |" for k, v in sorted(classes.items())) + """

## Rules

- This pack is the **positive regression baseline**.
- Do not degrade a CONFIRMED_* record solely because a new crawler is incomplete.
- Full PII JSONL is gitignored: `data/baseline/published-live-v1.jsonl`
- ID list (no PII beyond opaque ids): `docs/baseline/published-live-v1-ids.json`

## Gate

- True positives lost by new engine: **must be 0**
- New PUBLISHED without valid proof: **must be 0**
"""
    OUT_REPORT.write_text(report, encoding="utf-8")
    print(json.dumps({"count": 120, "classes": classes, "sha": EXPECTED}, indent=2))


if __name__ == "__main__":
    main()
