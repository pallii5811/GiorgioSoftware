#!/usr/bin/env python3
"""Build 50 Veneto gare review rows from existing OFFICIAL_SHADOW_INGEST ledger (no live write)."""
from __future__ import annotations

import csv
import json
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "data/shadow/ingest/veneto-awards-ledger.json"
OUT = ROOT / "docs/human-review/gare-final"
SUMMARY = OUT / "summary.json"


def write_html(path: Path, title: str, rows: list[dict], cols: list[str]) -> None:
    th = "".join(f"<th>{escape(c)}</th>" for c in cols)
    body = []
    for r in rows:
        tds = "".join(f"<td>{escape(str(r.get(c, '') or '')[:280])}</td>" for c in cols)
        body.append(f"<tr>{tds}</tr>")
    path.write_text(
        f"""<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>{escape(title)}</title>
<style>body{{font-family:system-ui;margin:24px}}table{{border-collapse:collapse;width:100%;font-size:12px}}
th,td{{border:1px solid #ddd;padding:6px}}th{{background:#111;color:#fff}}</style></head><body>
<h1>{escape(title)}</h1>
<p>humanReviewed=0 · origin OFFICIAL_SHADOW_INGEST ANAC OCDS</p>
<table><thead><tr>{th}</tr></thead><tbody>{''.join(body)}</tbody></table>
</body></html>""",
        encoding="utf-8",
    )


def write_csv(path: Path, rows: list[dict], cols: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})


def row_from_rec(r: dict) -> dict:
    cat = r.get("category") or "NON_CLASSIFICATO"
    if "undefined" in str(cat).lower() or cat == "GARE_LOW":
        cat = "NON_CLASSIFICATO"
    award = r.get("awardDate") or ""
    if award:
        award = str(award)[:10]
    amount = float(r.get("amount") or 0)
    winner = r.get("winner") or r.get("winnerName") or r.get("companyName") or ""
    if isinstance(winner, dict):
        winner = winner.get("name") or winner.get("identifier") or ""
    winner_ok = bool(str(winner).strip())
    cig = r.get("cig") or ""
    official = True
    actionable = bool(
        award
        and winner_ok
        and official
        and cig
        and cat in ("GARE_HIGH", "GARE_MEDIUM")
    )
    tier = "NOT_ACTIONABLE"
    if actionable and cat == "GARE_HIGH":
        tier = "HIGH"
    elif actionable:
        tier = "MEDIUM"
    return {
        "leadId": r.get("id") or f"ingest:{cig}",
        "companyName": str(winner)[:200],
        "region": "Veneto",
        "city": r.get("buyerCity") or "",
        "cig": cig,
        "amount": amount,
        "object": (r.get("object") or "")[:200],
        "category": cat,
        "awardDate": award,
        "officialSource": official,
        "winnerIdentified": winner_ok,
        "phone": "",
        "email": "",
        "website": "",
        "actionable": actionable,
        "tier": tier,
        "insuranceNeed": "WEAKLY_INFERRED" if actionable else "NOT_FOUND",
        "estimateKind": "ESTIMATE",
        "contractType": r.get("contractType") or "NON_CLASSIFICATO",
        "origin": "OFFICIAL_SHADOW_INGEST",
        "reviewer": "",
        "reviewed_at": "",
        "notes": "",
    }


def stats(rows: list[dict]) -> dict:
    return {
        "n": len(rows),
        "actionable": sum(1 for r in rows if r["actionable"]),
        "VERY_HIGH": sum(1 for r in rows if r["tier"] == "VERY_HIGH"),
        "HIGH": sum(1 for r in rows if r["tier"] == "HIGH"),
        "MEDIUM": sum(1 for r in rows if r["tier"] == "MEDIUM"),
        "LOW": sum(1 for r in rows if r["tier"] == "LOW"),
        "NOT_ACTIONABLE": sum(1 for r in rows if r["tier"] == "NOT_ACTIONABLE"),
        "missingDate": sum(1 for r in rows if not r["awardDate"]),
        "ambiguousWinner": sum(1 for r in rows if not r["winnerIdentified"]),
        "NON_CLASSIFICATO": sum(1 for r in rows if r["category"] == "NON_CLASSIFICATO"),
        "GARE_undefined": sum(1 for r in rows if "undefined" in str(r["category"]).lower()),
        "GARE_LOW_category": sum(1 for r in rows if r["category"] == "GARE_LOW"),
        "humanReviewed": 0,
        "source": "OFFICIAL_SHADOW_INGEST_ledger",
    }


def main() -> None:
    data = json.loads(LEDGER.read_text(encoding="utf-8"))
    records = data.get("records") or []
    # Prefer 2024+ with CIG+winner+amount
    pool = []
    for r in records:
        cig = r.get("cig")
        if not cig:
            continue
        winner = r.get("winner") or ""
        if isinstance(winner, dict):
            winner = winner.get("name") or ""
        if not str(winner).strip():
            continue
        if not (r.get("amount") or 0):
            continue
        ad = str(r.get("awardDate") or "")
        # prefer 2024+ but allow older if pool too small
        r["_ad"] = ad
        pool.append(r)
    pool.sort(key=lambda x: (0 if str(x.get("_ad") or "")[:4] >= "2024" else 1, -(float(x.get("amount") or 0))))
    print("pool_size", len(pool), flush=True)

    # diversify by contract type (by id to avoid O(n^2) dict equality)
    buckets = {"LAVORI": [], "SERVIZI": [], "FORNITURE": [], "OTHER": []}
    for r in pool:
        ct = r.get("contractType") or "OTHER"
        (buckets[ct] if ct in buckets else buckets["OTHER"]).append(r)
    selected_ids: set[str] = set()
    selected: list[dict] = []

    def take(rs: list[dict], n: int) -> None:
        for r in rs:
            if len(selected) >= 50:
                return
            rid = str(r.get("id") or r.get("cig"))
            if rid in selected_ids:
                continue
            selected_ids.add(rid)
            selected.append(r)
            if sum(1 for _ in selected if True) >= n and False:
                pass

    for key, n in (("LAVORI", 15), ("SERVIZI", 15), ("FORNITURE", 10), ("OTHER", 10)):
        before = len(selected)
        for r in buckets[key]:
            if len(selected) - before >= n:
                break
            rid = str(r.get("id") or r.get("cig"))
            if rid in selected_ids:
                continue
            selected_ids.add(rid)
            selected.append(r)
            if len(selected) >= 50:
                break
        if len(selected) >= 50:
            break
    for r in pool:
        if len(selected) >= 50:
            break
        rid = str(r.get("id") or r.get("cig"))
        if rid in selected_ids:
            continue
        selected_ids.add(rid)
        selected.append(r)
    selected = selected[:50]
    print("selected_size", len(selected), flush=True)
    if not selected:
        raise SystemExit("no veneto records selected from ledger")
    rows = [row_from_rec(r) for r in selected]
    # normalize category using relevance field if present
    for i, r in enumerate(selected):
        rel = r.get("relevance")
        if rel == "HIGH":
            rows[i]["category"] = "GARE_HIGH"
        elif rel == "MEDIUM":
            rows[i]["category"] = "GARE_MEDIUM"
        elif rows[i]["category"] in ("GARE_LOW", "") or "undefined" in str(rows[i]["category"]).lower():
            rows[i]["category"] = "NON_CLASSIFICATO"
        # recompute actionable after category fix
        rows[i]["actionable"] = bool(
            rows[i]["awardDate"]
            and rows[i]["winnerIdentified"]
            and rows[i]["cig"]
            and rows[i]["category"] in ("GARE_HIGH", "GARE_MEDIUM")
        )
        if rows[i]["actionable"] and rows[i]["category"] == "GARE_HIGH":
            rows[i]["tier"] = "HIGH"
        elif rows[i]["actionable"]:
            rows[i]["tier"] = "MEDIUM"
        else:
            rows[i]["tier"] = "NOT_ACTIONABLE"

    cols = list(rows[0].keys())
    write_html(OUT / "gare-veneto.html", "Gare Veneto (50) OFFICIAL_SHADOW_INGEST", rows, cols)
    write_csv(OUT / "gare-veneto.csv", rows, cols)

    summary = json.loads(SUMMARY.read_text(encoding="utf-8")) if SUMMARY.exists() else {}
    summary["Veneto"] = stats(rows)
    summary["humanReviewed"] = 0
    SUMMARY.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary["Veneto"], indent=2))


if __name__ == "__main__":
    main()
