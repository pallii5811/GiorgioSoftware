#!/usr/bin/env python3
"""Deterministic stratified selection for Shadow Batch 1 — 25+25 Sanità, 25+25 Gare."""
from __future__ import annotations

import hashlib
import json
import random
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

SEED = 20260718
DB = Path("data/shadow/db/giorgio-shadow-20260718-rerun.db")
OUT_DIR = Path("docs/shadow/batch1")
DATA_DIR = Path("data/shadow/batch1")
VERDICT_RE = re.compile(r"\[V:(HOT|PUB|REV)\]", re.I)
HIST_RE = re.compile(r"\[SHADOW_HIST_VERDICT:([A-Z]+)\]")

CAMPANIA_PROV = ["Napoli", "Salerno", "Caserta", "Avellino", "Benevento"]
VENETO_PROV = ["Verona", "Vicenza", "Padova", "Venezia", "Treviso", "Belluno", "Rovigo"]


def hist_verdict(ev: str | None) -> str:
    if not ev:
        return "OTHER"
    m = HIST_RE.search(ev)
    if m:
        return {"HOT": "HOT", "PUB": "PUBLISHED", "PUBLISHED": "PUBLISHED", "REV": "REVIEW", "REVIEW": "REVIEW"}.get(
            m.group(1).upper(), m.group(1).upper()
        )
    m = VERDICT_RE.search(ev)
    if not m:
        return "OTHER"
    return {"HOT": "HOT", "PUB": "PUBLISHED", "REV": "REVIEW"}.get(m.group(1).upper(), "OTHER")


def stable_key(row_id: str) -> str:
    return hashlib.sha256(f"{SEED}:{row_id}".encode()).hexdigest()


def pick_stratified(rows: list[sqlite3.Row], n: int, region: str) -> tuple[list[dict], dict]:
    """Pick n rows with soft quotas; deterministic via seed sort."""
    scored = sorted(rows, key=lambda r: (stable_key(r["id"]), r["id"]))
    by_v = defaultdict(list)
    for r in scored:
        by_v[hist_verdict(r["evidence"])].append(r)

    selected: list[sqlite3.Row] = []
    used = set()

    def take(pool: list[sqlite3.Row], k: int):
        got = []
        for r in pool:
            if r["id"] in used:
                continue
            got.append(r)
            used.add(r["id"])
            if len(got) >= k:
                break
        return got

    # Soft quotas
    selected += take(by_v.get("HOT", []), 7)
    selected += take(by_v.get("PUBLISHED", []), 4)
    selected += take(by_v.get("REVIEW", []), 4)

    # Prefer group-ish websites, PDF mentions, missing site, complex
    def flag(r):
        ev = (r["evidence"] or "").lower()
        web = (r["website"] or "").lower()
        return {
            "group": any(x in web for x in (".it/", "group", "kos", "gvm", "synlab", "centro")) or "gruppo" in ev,
            "pdf": ".pdf" in ev or "pdf" in ev,
            "nosite": not (r["website"] or "").strip(),
            "complex": (r["pagesVisited"] or 0) >= 20 or "spa" in ev or "javascript" in ev,
            "expired": "scaduta" in ev or "obsolete" in ev,
            "auto": "autoassicur" in ev,
        }

    remain = [r for r in scored if r["id"] not in used]
    for key, need in [("group", 3), ("pdf", 3), ("complex", 2), ("nosite", 2), ("expired", 1), ("auto", 1)]:
        pool = [r for r in remain if flag(r)[key]]
        for r in take(pool, need):
            selected.append(r)
            remain = [x for x in remain if x["id"] not in used]

    # Province coverage
    prov_list = CAMPANIA_PROV if region == "Campania" else VENETO_PROV
    for p in prov_list:
        if len(selected) >= n:
            break
        pool = [
            r
            for r in scored
            if r["id"] not in used and p.lower() in ((r["city"] or "") + " " + (r["companyName"] or "")).lower()
        ]
        selected += take(pool, 1)

    # Fill to n
    for r in scored:
        if len(selected) >= n:
            break
        if r["id"] not in used:
            selected.append(r)
            used.add(r["id"])

    selected = selected[:n]
    dist = Counter(hist_verdict(r["evidence"]) for r in selected)
    cities = Counter((r["city"] or "?") for r in selected)
    flags = Counter()
    out_rows = []
    for r in selected:
        f = flag(r)
        for k, v in f.items():
            if v:
                flags[k] += 1
        out_rows.append(
            {
                "id": r["id"],
                "companyName": r["companyName"],
                "region": r["region"],
                "city": r["city"],
                "category": r["category"],
                "website": r["website"],
                "oldVerdict": hist_verdict(r["evidence"]),
                "leadScore": r["leadScore"],
                "pagesVisited": r["pagesVisited"],
                "flags": {k: v for k, v in f.items() if v},
                "selectionReason": "stratified-seed-%s" % SEED,
            }
        )
    meta = {
        "seed": SEED,
        "region": region,
        "n": len(out_rows),
        "verdictDist": dict(dist),
        "cityDist": dict(cities.most_common(20)),
        "flagDist": dict(flags),
        "query": "SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=? ORDER BY stable_hash(seed,id)",
    }
    return out_rows, meta


def pick_gare(rows: list[sqlite3.Row], n: int, region: str) -> tuple[list[dict], dict]:
    scored = sorted(rows, key=lambda r: (stable_key(r["id"]), r["id"]))
    selected = scored[:n]
    # Prefer diversity by amount bands + contact presence
    bands = {"hi": [], "mid": [], "lo": [], "contact": [], "nocontact": []}
    for r in scored:
        amt = float(r["tenderAmount"] or 0)
        if amt >= 500_000:
            bands["hi"].append(r)
        elif amt >= 75_000:
            bands["mid"].append(r)
        else:
            bands["lo"].append(r)
        if r["phone"] or r["email"]:
            bands["contact"].append(r)
        else:
            bands["nocontact"].append(r)

    used = set()
    picked = []

    def take(pool, k):
        for r in pool:
            if r["id"] in used:
                continue
            picked.append(r)
            used.add(r["id"])
            if len([x for x in picked]) >= len(used) and sum(1 for x in picked if x["id"] == r["id"]) :
                pass
            if len(picked) >= n:
                return
            if sum(1 for x in picked if x in pool[:]) :  # noop keep simple
                pass
            # stop when took k new from this call
            # recount from start of this take — simplify:
            pass

    # simpler fill
    picked = []
    used = set()
    for pool, k in [
        (bands["hi"], 5),
        (bands["mid"], 8),
        (bands["lo"], 5),
        (bands["contact"], 5),
        (bands["nocontact"], 3),
    ]:
        c = 0
        for r in pool:
            if r["id"] in used:
                continue
            picked.append(r)
            used.add(r["id"])
            c += 1
            if c >= k or len(picked) >= n:
                break
        if len(picked) >= n:
            break
    for r in scored:
        if len(picked) >= n:
            break
        if r["id"] not in used:
            picked.append(r)
            used.add(r["id"])
    picked = picked[:n]

    out = []
    for r in picked:
        ev = r["evidence"] or ""
        region_basis = ["buyer_sa"]  # Lead.region = stazione appaltante CAP filter
        if "sede vincitore" in ev.lower():
            region_basis.append("winner_seat")
        if "luogo" in ev.lower() or "esecuzione" in ev.lower():
            region_basis.append("execution_place")
        out.append(
            {
                "id": r["id"],
                "companyName": r["companyName"],
                "tenderWinner": r["tenderWinner"],
                "tenderCig": r["tenderCig"],
                "tenderAmount": r["tenderAmount"],
                "tenderObject": (r["tenderObject"] or "")[:160],
                "region": r["region"],
                "city": r["city"],
                "category": r["category"],
                "leadScore": r["leadScore"],
                "phone": bool(r["phone"]),
                "email": bool(r["email"]),
                "regionBasis": region_basis,
                "selectionReason": "stratified-seed-%s" % SEED,
            }
        )
    amounts = [float(r["tenderAmount"] or 0) for r in picked]
    meta = {
        "seed": SEED,
        "region": region,
        "n": len(out),
        "categoryDist": dict(Counter((r["category"] or "?") for r in picked)),
        "amountMin": min(amounts) if amounts else 0,
        "amountMax": max(amounts) if amounts else 0,
        "withContact": sum(1 for r in picked if r["phone"] or r["email"]),
        "regionBasisNote": "Lead.region derives from stazione appaltante (buyer CAP); winner seat / execution recorded when present in evidence",
        "query": "SELECT * FROM Lead WHERE type='TENDER' AND region=? ORDER BY stable_hash(seed,id)",
    }
    return out, meta


def main() -> None:
    random.seed(SEED)
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    sanita = {}
    for region in ("Campania", "Veneto"):
        rows = c.execute(
            "SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=? ",
            (region,),
        ).fetchall()
        picks, meta = pick_stratified(rows, 25, region)
        sanita[region] = {"meta": meta, "ids": [p["id"] for p in picks], "rows": picks}
        (OUT_DIR / f"sanita-selection-{region.lower()}.json").write_text(
            json.dumps({"meta": meta, "ids": [p["id"] for p in picks]}, indent=2),
            encoding="utf-8",
        )
        # sensitive full rows gitignored
        (DATA_DIR / f"sanita-{region.lower()}-full.json").write_text(
            json.dumps(picks, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    gare = {}
    for region in ("Campania", "Veneto"):
        rows = c.execute(
            "SELECT * FROM Lead WHERE type='TENDER' AND region=? ",
            (region,),
        ).fetchall()
        picks, meta = pick_gare(rows, 25, region)
        gare[region] = {"meta": meta, "ids": [p["id"] for p in picks], "rows": picks}
        (OUT_DIR / f"gare-selection-{region.lower()}.json").write_text(
            json.dumps({"meta": meta, "ids": [p["id"] for p in picks]}, indent=2),
            encoding="utf-8",
        )
        (DATA_DIR / f"gare-{region.lower()}-full.json").write_text(
            json.dumps(picks, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    c.close()

    # Markdown reports (no PII beyond counts)
    def md_sanita():
        lines = [
            "# S1 Sanità selection",
            "",
            f"**Seed:** `{SEED}`",
            "",
            "Query: `SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=?` then deterministic hash order + soft quotas.",
            "",
        ]
        for region, pack in sanita.items():
            m = pack["meta"]
            lines += [
                f"## {region}",
                f"- n: {m['n']}",
                f"- verdictDist: `{m['verdictDist']}`",
                f"- flagDist: `{m['flagDist']}`",
                f"- cities (top): `{m['cityDist']}`",
                f"- ids: {len(pack['ids'])} (full list in json)",
                "",
            ]
        return "\n".join(lines)

    def md_gare():
        lines = [
            "# G1 Gare selection",
            "",
            f"**Seed:** `{SEED}`",
            "",
            "Region basis: Lead.region = stazione appaltante (buyer CAP). Winner seat / execution noted when present in evidence.",
            "",
        ]
        for region, pack in gare.items():
            m = pack["meta"]
            lines += [
                f"## {region}",
                f"- n: {m['n']}",
                f"- categoryDist: `{m['categoryDist']}`",
                f"- amount range: {m['amountMin']} – {m['amountMax']}",
                f"- withContact: {m['withContact']}",
                "",
            ]
        return "\n".join(lines)

    (OUT_DIR / "sanita-selection.md").write_text(md_sanita(), encoding="utf-8")
    (OUT_DIR / "gare-selection.md").write_text(md_gare(), encoding="utf-8")

    summary = {
        "seed": SEED,
        "sanitaCampania": len(sanita["Campania"]["ids"]),
        "sanitaVeneto": len(sanita["Veneto"]["ids"]),
        "gareCampania": len(gare["Campania"]["ids"]),
        "gareVeneto": len(gare["Veneto"]["ids"]),
        "gareVenetoAvailableInSnapshot": 2,
        "gareVenetoShortfall": max(0, 25 - len(gare["Veneto"]["ids"])),
        "totalSelected": (
            len(sanita["Campania"]["ids"])
            + len(sanita["Veneto"]["ids"])
            + len(gare["Campania"]["ids"])
            + len(gare["Veneto"]["ids"])
        ),
        "targetTotal": 100,
        "blocker": None
        if len(gare["Veneto"]["ids"]) >= 25
        else "SNAPSHOT_HAS_ONLY_2_VENETO_TENDER_LEADS",
    }
    (OUT_DIR / "selection-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
