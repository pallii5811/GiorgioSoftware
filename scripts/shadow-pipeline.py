#!/usr/bin/env python3
"""Shadow snapshot + legacy quarantine on ISOLATED sqlite copy only."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHADOW_DB = ROOT / "data" / "shadow" / "db" / "giorgio-shadow-20260718.db"
LIVE_MARKERS = ("/opt/leadsniper/prisma/dev.db",)
EV_RE = re.compile(
    r"\[EV_V:(\d+)\s+VD_V:(\d+)\s+LEGACY:(CURRENT|LEGACY_UNVERIFIED|RESCAN_REQUIRED)\]",
    re.I,
)
VERDICT_RE = re.compile(r"\[V:(HOT|PUB|REV)\]", re.I)
CURRENT_EV = 2
CURRENT_VD = 2


def die(msg: str, code: int = 78) -> None:
    print(f"SHADOW GUARD REFUSED: {msg}", file=sys.stderr)
    sys.exit(code)


def assert_shadow_env() -> None:
    if os.environ.get("SHADOW_MODE") not in ("true", "1"):
        die("SHADOW_MODE must be true")
    if not os.environ.get("SHADOW_DATABASE_ID"):
        die("SHADOW_DATABASE_ID required")
    for flag in (
        "DISABLE_EMAILS",
        "DISABLE_WEBHOOKS",
        "DISABLE_CUSTOMER_NOTIFICATIONS",
        "DISABLE_PUBLIC_QUEUE_PUBLISH",
        "DISABLE_PRODUCTION_CRON",
    ):
        if os.environ.get(flag) not in ("true", "1"):
            die(f"{flag} must be true")
    db = os.environ.get("SHADOW_DB_PATH", str(SHADOW_DB))
    for m in LIVE_MARKERS:
        if m in db.replace("\\", "/"):
            die("SHADOW_DB_PATH points to live Hetzner path")
    if not Path(db).exists():
        die(f"shadow db missing: {db}")
    os.environ["SHADOW_DB_PATH"] = db


def verdict_token(evidence: str | None) -> str | None:
    if not evidence:
        return None
    m = VERDICT_RE.search(evidence)
    if not m:
        return None
    t = m.group(1).upper()
    return {"HOT": "HOT", "PUB": "PUBLISHED", "REV": "REVIEW"}.get(t, t)


def is_legacy(evidence: str | None) -> bool:
    if not evidence:
        return True
    m = EV_RE.search(evidence)
    if not m:
        return True
    if int(m.group(1)) < CURRENT_EV or int(m.group(2)) < CURRENT_VD:
        return True
    if m.group(3).upper() != "CURRENT":
        return True
    return False


def is_actionable(row: sqlite3.Row) -> bool:
    evidence = row["evidence"]
    if is_legacy(evidence):
        return False
    v = verdict_token(evidence)
    if v == "REVIEW" or v is None:
        return False
    if row["type"] == "HEALTHCARE" and v not in ("HOT", "PUBLISHED"):
        return False
    if row["type"] == "TENDER":
        cat = (row["category"] or "").upper()
        if cat and cat not in ("GARE_HIGH", "GARE_MEDIUM"):
            return False
    return True


def connect(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(str(db))


def snapshot(db: Path) -> dict:
    before = ROOT / "data" / "shadow" / "before"
    before.mkdir(parents=True, exist_ok=True)
    c = connect(db)
    c.row_factory = sqlite3.Row
    cur = c.cursor()
    leads = cur.execute("SELECT * FROM Lead").fetchall()
    san_path = before / "sanita-records.jsonl"
    gare_path = before / "gare-records.jsonl"
    aq_path = before / "actionable-queue.jsonl"
    n_san = n_gare = n_aq = 0
    with san_path.open("w", encoding="utf-8") as fs, gare_path.open(
        "w", encoding="utf-8"
    ) as fg, aq_path.open("w", encoding="utf-8") as fa:
        for r in leads:
            v = verdict_token(r["evidence"])
            markers = EV_RE.search(r["evidence"] or "")
            base = {
                "id": r["id"],
                "region": r["region"],
                "companyName": r["companyName"],
                "city": r["city"],
                "website": r["website"],
                "verdict": v,
                "leadScore": r["leadScore"],
                "evidenceVersion": int(markers.group(1)) if markers else None,
                "verdictVersion": int(markers.group(2)) if markers else None,
                "legacyStatus": markers.group(3).upper() if markers else None,
                "lastScannedAt": r["lastScannedAt"],
                "pagesVisited": r["pagesVisited"],
                "type": r["type"],
                "category": r["category"],
                "fingerprint": hashlib.sha256(
                    f"{r['id']}|{r['evidence']}|{r['leadScore']}".encode()
                ).hexdigest()[:16],
            }
            if r["type"] == "HEALTHCARE":
                fs.write(json.dumps(base, ensure_ascii=False) + "\n")
                n_san += 1
            elif r["type"] == "TENDER":
                g = {
                    **base,
                    "tenderCig": r["tenderCig"],
                    "tenderAmount": r["tenderAmount"],
                }
                fg.write(json.dumps(g, ensure_ascii=False) + "\n")
                n_gare += 1
            if is_actionable(r):
                fa.write(json.dumps({"id": r["id"], "type": r["type"], "verdict": v}, ensure_ascii=False) + "\n")
                n_aq += 1
    c.close()
    return {"sanita": n_san, "gare": n_gare, "actionable": n_aq}


def audit_stats(db: Path) -> dict:
    c = connect(db)
    c.row_factory = sqlite3.Row
    cur = c.cursor()
    out = {"generatedAt": datetime.now(timezone.utc).isoformat(), "byRegion": {}}
    for region in ("Campania", "Veneto"):
        rows = cur.execute(
            "SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=?", (region,)
        ).fetchall()
        stats = {
            "total": len(rows),
            "HOT": 0,
            "PUBLISHED": 0,
            "REVIEW": 0,
            "legacy": 0,
            "legacyHot": 0,
            "legacyPublished": 0,
            "missingEvidenceVersion": 0,
            "missingIdentityHint": 0,
            "missingCompletenessHint": 0,
            "actionable": 0,
            "rescanRequired": 0,
        }
        for r in rows:
            v = verdict_token(r["evidence"])
            if v == "HOT":
                stats["HOT"] += 1
            elif v == "PUBLISHED":
                stats["PUBLISHED"] += 1
            elif v == "REVIEW":
                stats["REVIEW"] += 1
            if not EV_RE.search(r["evidence"] or ""):
                stats["missingEvidenceVersion"] += 1
            if not re.search(
                r"IdentityEvidence|OFFICIAL_CONFIRMED|identityVerified",
                r["evidence"] or "",
                re.I,
            ):
                stats["missingIdentityHint"] += 1
            if not re.search(
                r"CRAWL_COMPLETE|completeness|Crawl incompleto",
                r["evidence"] or "",
                re.I,
            ):
                stats["missingCompletenessHint"] += 1
            if is_legacy(r["evidence"]):
                stats["legacy"] += 1
                if v == "HOT":
                    stats["legacyHot"] += 1
                    stats["rescanRequired"] += 1
                if v == "PUBLISHED":
                    stats["legacyPublished"] += 1
                    stats["rescanRequired"] += 1
            if is_actionable(r):
                stats["actionable"] += 1
        out["byRegion"][region] = stats
    # gare actionable
    gare = cur.execute("SELECT * FROM Lead WHERE type='TENDER'").fetchall()
    out["gare"] = {
        "total": len(gare),
        "actionable": sum(1 for r in gare if is_actionable(r)),
    }
    c.close()
    return out


def quarantine_apply(db: Path) -> dict:
    if os.environ.get("SHADOW_ALLOW_DB_WRITE") not in ("true", "1"):
        die("SHADOW_ALLOW_DB_WRITE must be true for apply")
    if os.environ.get("SHADOW_ALLOW_APPLY") not in ("1", "true"):
        die("SHADOW_ALLOW_APPLY must be 1 for apply")
    marker = "[EV_V:2 VD_V:2 LEGACY:RESCAN_REQUIRED]"
    hist_prefix = "[SHADOW_HIST_VERDICT:"
    c = connect(db)
    c.row_factory = sqlite3.Row
    cur = c.cursor()
    rows = cur.execute(
        "SELECT id, evidence FROM Lead WHERE type='HEALTHCARE'"
    ).fetchall()
    updated = 0
    skipped = 0
    for r in rows:
        ev = r["evidence"] or ""
        if "LEGACY:RESCAN_REQUIRED" in ev or "LEGACY:CURRENT" in ev:
            # already versioned — skip if already RESCAN_REQUIRED or CURRENT
            if "LEGACY:RESCAN_REQUIRED" in ev:
                skipped += 1
                continue
            if "LEGACY:CURRENT" in ev:
                skipped += 1
                continue
        v = verdict_token(ev) or "UNKNOWN"
        # strip old version marker
        cleaned = EV_RE.sub("", ev).strip()
        if hist_prefix not in cleaned:
            cleaned = f"{hist_prefix}{v}] {cleaned}".strip()
        new_ev = f"{cleaned} {marker}".strip()
        if new_ev == ev:
            skipped += 1
            continue
        cur.execute("UPDATE Lead SET evidence=? WHERE id=?", (new_ev, r["id"]))
        updated += 1
    c.commit()
    total = cur.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
    c.close()
    return {"updated": updated, "skippedAlreadyMarked": skipped, "leadTotal": total}


def main() -> None:
    assert_shadow_env()
    db = Path(os.environ["SHADOW_DB_PATH"])
    cmd = sys.argv[1] if len(sys.argv) > 1 else "audit"

    if cmd == "snapshot":
        print(json.dumps(snapshot(db), indent=2))
    elif cmd == "audit":
        print(json.dumps(audit_stats(db), indent=2))
    elif cmd == "quarantine-dry-run":
        stats = audit_stats(db)
        stats["dryRun"] = True
        print(json.dumps(stats, indent=2))
    elif cmd == "quarantine-apply":
        first = quarantine_apply(db)
        second = quarantine_apply(db)
        print(
            json.dumps(
                {
                    "firstApply": first,
                    "secondApply": second,
                    "idempotent": second["updated"] == 0,
                    "auditAfter": audit_stats(db),
                },
                indent=2,
            )
        )
    else:
        die(f"unknown command {cmd}", 2)


if __name__ == "__main__":
    main()
