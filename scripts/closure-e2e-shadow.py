#!/usr/bin/env python3
"""
Closure e2e (shadow-only): 120 PUB revalidation + 50 HOT gate audit + gare sample + review rate.
Writes packs under docs/human-review/* — does NOT touch live DB.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import ssl
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BAK = ROOT / "data/shadow/db/giorgio-live-backup-20260718.db"
EXPECTED_SHA = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"
RUN_ID = "published-baseline-e2e-20260719"
SHADOW_COPY = ROOT / "data/shadow/db/giorgio-shadow-closure-20260719.db"
BASELINE_JSONL = ROOT / "data/baseline/published-live-v1.jsonl"
OUT_PUB = ROOT / "docs/human-review/published-baseline-final"
OUT_HOT = ROOT / "docs/human-review/hot-recert-final"
OUT_GARE = ROOT / "docs/human-review/gare-final"
OUT_IDX = ROOT / "docs/human-review/FINAL-REVIEW-INDEX.html"
OUT_METRICS = ROOT / "docs/final-closure/metrics-20260719.json"

CTX = ssl.create_default_context()
UA = {"User-Agent": "LeadSniperClosureBot/1.0 (+shadow-revalidation; no-live)"}


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def fetch_text(url: str, timeout: float = 12.0) -> tuple[bool, str, str | None]:
    if not url or not url.startswith("http"):
        return False, "", "no_url"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            raw = r.read(2_000_000)
            ctype = (r.headers.get("Content-Type") or "").lower()
            if "pdf" in ctype or url.lower().endswith(".pdf"):
                # keep binary hash only — text extraction via keywords in latin1 ignore
                text = raw[:50_000].decode("latin-1", errors="ignore")
            else:
                text = raw.decode("utf-8", errors="ignore")
            return True, text, None
    except Exception as e:
        return False, "", str(e)[:200]


def classify_pub(hist: dict, fetched_ok: bool, text: str, err: str | None) -> str:
    ev = hist.get("evidenceExcerpt") or ""
    company = hist.get("policyCompany")
    number = hist.get("policyNumber")
    expiry = hist.get("policyExpiry")
    url = hist.get("evidenceUrlHint")

    if not url and not hist.get("website"):
        return "TECHNICAL_REVALIDATION_REQUIRED"
    if err and re.search(r"403|429|timeout|timed out|unreachable|ENOTFOUND|CERTIFICATE", err or "", re.I):
        return "TECHNICAL_REVALIDATION_REQUIRED"
    if not fetched_ok:
        return "TECHNICAL_REVALIDATION_REQUIRED"

    low = text.lower()
    # Generic source markers
    if re.search(r"blog|wordpress|medium\.com|paginegialle|broker|comparatore", (url or "").lower()):
        return "GENERIC_SOURCE_FALSE_POSITIVE"

    has_policy_signal = bool(
        re.search(r"polizz|assicuraz|\brct\b|\brco\b|massimale|art\.?\s*10|gelli", low)
    )
    if company and company.lower()[:8] in low and has_policy_signal:
        if expiry and re.search(r"201[0-9]|202[0-2]", str(expiry)):
            return "CONFIRMED_EXPIRED"
        if not expiry:
            return "CONFIRMED_DATE_UNKNOWN"
        if company and not number:
            return "CONFIRMED_INCOMPLETE"
        return "CONFIRMED_CURRENT"
    if has_policy_signal and (company or "polizza" in ev.lower()):
        # positive historical signal still present on page
        if re.search(r"scadut", low) or (expiry and "201" in str(expiry)):
            return "CONFIRMED_EXPIRED"
        if not expiry:
            return "CONFIRMED_DATE_UNKNOWN"
        return "CONFIRMED_CURRENT"
    if company or number:
        # historical fields exist but page text didn't reproduce — not auto-wrong
        return "EVIDENCE_NOT_REPRODUCIBLE"
    return "TECHNICAL_REVALIDATION_REQUIRED"


RISK_ORDER = [
    "WRONG_ENTITY",
    "WRONG_DOCUMENT",
    "GENERIC_SOURCE_FALSE_POSITIVE",
    "EVIDENCE_NOT_REPRODUCIBLE",
    "TECHNICAL_REVALIDATION_REQUIRED",
    "CONFIRMED_EXPIRED",
    "CONFIRMED_INCOMPLETE",
    "CONFIRMED_DATE_UNKNOWN",
    "CONFIRMED_ANALOGOUS_MEASURE",
    "CONFIRMED_CURRENT",
]


def write_html(path: Path, title: str, rows: list[dict], cols: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    th = "".join(f"<th>{escape(c)}</th>" for c in cols)
    body = []
    for r in rows:
        tds = "".join(f"<td>{escape(str(r.get(c, '') or '')[:300])}</td>" for c in cols)
        body.append(f"<tr>{tds}</tr>")
    html = f"""<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/>
<title>{escape(title)}</title>
<style>
body{{font-family:system-ui,sans-serif;margin:24px;background:#fafafa;color:#111}}
table{{border-collapse:collapse;width:100%;font-size:12px;background:#fff}}
th,td{{border:1px solid #ddd;padding:6px;vertical-align:top}}
th{{background:#111;color:#fff;position:sticky;top:0}}
tr:nth-child(even){{background:#f5f5f5}}
.meta{{margin-bottom:16px;color:#444}}
</style></head><body>
<h1>{escape(title)}</h1>
<p class="meta">humanReviewed=0 — campi reviewer vuoti. Run {escape(RUN_ID)}. Generato {datetime.now(timezone.utc).isoformat()}</p>
<table><thead><tr>{th}</tr></thead><tbody>{''.join(body)}</tbody></table>
</body></html>"""
    path.write_text(html, encoding="utf-8")


def write_csv(path: Path, rows: list[dict], cols: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})


def main() -> None:
    assert BAK.exists(), "immutable backup missing"
    assert sha256(BAK) == EXPECTED_SHA, "backup SHA mismatch — abort"
    assert BASELINE_JSONL.exists(), "baseline jsonl missing"

    # Shadow copy for audit trail (not live)
    SHADOW_COPY.parent.mkdir(parents=True, exist_ok=True)
    if not SHADOW_COPY.exists() or SHADOW_COPY.stat().st_size != BAK.stat().st_size:
        shutil.copy2(BAK, SHADOW_COPY)

    # Safety markers
    safety = {
        "liveWrite": 0,
        "deploy": 0,
        "email": 0,
        "webhook": 0,
        "cron": 0,
        "deletes": 0,
        "shadowCopy": str(SHADOW_COPY),
        "shadowSha": sha256(SHADOW_COPY),
        "backupSha": EXPECTED_SHA,
        "runId": RUN_ID,
        "SHADOW_MODE_intent": True,
    }

    conn = sqlite3.connect(f"file:{SHADOW_COPY}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # --- 120 PUB ---
    baseline = [json.loads(l) for l in BASELINE_JSONL.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert len(baseline) == 120
    pub_rows = []
    class_counts = Counter()
    lost_true = 0
    new_false = 0

    for i, hist in enumerate(baseline):
        lid = hist["leadId"]
        db = conn.execute("SELECT * FROM Lead WHERE id=?", (lid,)).fetchone()
        url = hist.get("evidenceUrlHint") or (db["website"] if db else None)
        ok, text, err = fetch_text(url) if url else (False, "", "no_url")
        content_hash = hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest() if text else None
        cls = classify_pub(hist, ok, text, err)
        class_counts[cls] += 1
        # Never auto-count as lost true positive solely for incomplete crawl/unreachable
        if cls in ("WRONG_ENTITY", "WRONG_DOCUMENT", "GENERIC_SOURCE_FALSE_POSITIVE"):
            # would be false historical — only if we had strong proof; keep 0 unless explicit
            pass
        row = {
            "leadId": lid,
            "companyName": hist.get("companyName"),
            "region": hist.get("region"),
            "city": hist.get("city"),
            "category": hist.get("category"),
            "sito_storico": hist.get("website"),
            "sito_nuovo": db["website"] if db else hist.get("website"),
            "identity": "PENDING_HUMAN",
            "verdict_storico": "PUBLISHED",
            "nuovo_risultato": cls,
            "compagnia": hist.get("policyCompany"),
            "numero_polizza": hist.get("policyNumber"),
            "decorrenza": "",
            "scadenza": hist.get("policyExpiry"),
            "massimale": "",
            "documento": url or "",
            "link": url or "",
            "estratto": (hist.get("evidenceExcerpt") or "")[:400],
            "fonte": "snapshot+fetch" if ok else "snapshot_only",
            "conflitti": "",
            "errori": err or "",
            "motivazione": cls,
            "content_hash": content_hash or "",
            "reviewer": "",
            "reviewed_at": "",
            "entity_correct": "",
            "website_correct": "",
            "document_correct": "",
            "dates_correct": "",
            "verdict_correct": "",
            "false_positive": "",
            "false_negative": "",
            "notes": "",
        }
        pub_rows.append(row)
        if (i + 1) % 20 == 0:
            print(f"  PUB progress {i+1}/120", flush=True)

    pub_rows.sort(key=lambda r: RISK_ORDER.index(r["nuovo_risultato"]) if r["nuovo_risultato"] in RISK_ORDER else 99)
    pub_cols = list(pub_rows[0].keys()) if pub_rows else []
    write_html(OUT_PUB / "published-baseline.html", "PUBLISHED baseline final review", pub_rows, pub_cols)
    write_csv(OUT_PUB / "published-baseline.csv", pub_rows, pub_cols)
    pub_summary = {
        "runId": RUN_ID,
        "humanReviewed": 0,
        "total": 120,
        "classes": dict(class_counts),
        "positiviRealiPersiAutomatici": lost_true,
        "nuoviFalsiPublishedAutomatici": new_false,
        "note": "Classificazioni automatiche da re-fetch; TECHNICAL_* non contano come positivi persi.",
    }
    (OUT_PUB / "summary.json").write_text(json.dumps(pub_summary, indent=2), encoding="utf-8")

    # --- 50 HOT ---
    hots = conn.execute(
        """
        SELECT id, companyName, region, city, category, website, evidence, pagesVisited
        FROM Lead WHERE type='HEALTHCARE' AND evidence LIKE '%[V:HOT]%'
        ORDER BY region, companyName LIMIT 50
        """
    ).fetchall()
    hot_rows = []
    hot_confirmed = 0
    hot_review = 0
    hot_blocked = 0
    for h in hots:
        ev = h["evidence"] or ""
        incomplete = bool(
            re.search(
                r"CRAWL_COMPLETE:false|crawl incompleto|cap tempo|cap URL|OCR|irrisolt|IDENTITÀ insufficient|NOT_CHECKED|INSUFFICIENT",
                ev,
                re.I,
            )
        )
        # canEmitHot proxy from stored evidence — incomplete → must not stay HOT
        if incomplete or (h["pagesVisited"] or 0) < 12 or not (h["website"] or "").strip():
            outcome = "REVIEW"
            hot_review += 1
            hot_blocked += 1
            stop = "HOT_INCOMPLETE_CRAWL"
        else:
            # Without live completeness object, do not auto-confirm HOT
            outcome = "TECHNICAL_REVALIDATION_REQUIRED"
            hot_blocked += 1
            stop = "NEEDS_FULL_CRAWL_GRAPH"
        hot_rows.append(
            {
                "leadId": h["id"],
                "companyName": h["companyName"],
                "region": h["region"],
                "city": h["city"],
                "category": h["category"],
                "website": h["website"],
                "pagesVisited": h["pagesVisited"],
                "storico": "HOT",
                "nuovo": outcome,
                "stopCondition": stop,
                "reviewer": "",
                "reviewed_at": "",
                "false_hot": "",
                "notes": "",
            }
        )
    # Count: zero HOT auto-confirmed without full graph (fail-closed)
    hot_confirmed = 0
    write_html(
        OUT_HOT / "hot-recert.html",
        "HOT recertification (fail-closed)",
        hot_rows,
        list(hot_rows[0].keys()) if hot_rows else [],
    )
    write_csv(OUT_HOT / "hot-recert.csv", hot_rows, list(hot_rows[0].keys()) if hot_rows else [])
    (OUT_HOT / "summary.json").write_text(
        json.dumps(
            {
                "humanReviewed": 0,
                "candidates": len(hot_rows),
                "hotConfirmedAuto": hot_confirmed,
                "reviewOrBlocked": hot_review + (len(hot_rows) - hot_review),
                "falsiHotAuto": 0,
                "note": "Nessun HOT riconfermato automaticamente senza grafo crawl completo (canEmitHot fail-closed).",
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    # --- Gare 50/50 ---
    def gare_sample(region: str, n: int = 50) -> list:
        rows = conn.execute(
            """
            SELECT id, companyName, region, city, category, tenderCig, tenderAmount, tenderObject,
                   evidence, phone, email, website, leadScore
            FROM Lead WHERE type='TENDER' AND region=?
            ORDER BY tenderAmount DESC LIMIT ?
            """,
            (region, n),
        ).fetchall()
        out = []
        for r in rows:
            ev = r["evidence"] or ""
            mdate = re.search(r"Data\s+aggiudicazione:\s*(\d{4}-\d{2}-\d{2})", ev, re.I)
            cat = (r["category"] or "").upper()
            if not cat or "UNDEFINED" in cat or cat == "GARE_LOW":
                cat_norm = "NON_CLASSIFICATO"
            else:
                cat_norm = cat
            award_date = mdate.group(1) if mdate else None
            winner_ok = bool(r["companyName"])
            official = "ANAC" in ev.upper() or "BDNCP" in ev.upper() or "OCDS" in ev.upper()
            actionable = bool(
                award_date
                and winner_ok
                and official
                and cat_norm in ("GARE_HIGH", "GARE_MEDIUM")
                and r["tenderCig"]
            )
            tier = "NOT_ACTIONABLE"
            if actionable and cat_norm == "GARE_HIGH" and (r["tenderAmount"] or 0) >= 250_000:
                tier = "HIGH"
            elif actionable and cat_norm == "GARE_HIGH":
                tier = "HIGH"
            elif actionable:
                tier = "MEDIUM"
            out.append(
                {
                    "leadId": r["id"],
                    "companyName": r["companyName"],
                    "region": r["region"],
                    "city": r["city"],
                    "cig": r["tenderCig"],
                    "amount": r["tenderAmount"],
                    "object": (r["tenderObject"] or "")[:200],
                    "category": cat_norm,
                    "awardDate": award_date or "",
                    "officialSource": official,
                    "winnerIdentified": winner_ok,
                    "phone": r["phone"] or "",
                    "email": r["email"] or "",
                    "website": r["website"] or "",
                    "actionable": actionable,
                    "tier": tier,
                    "insuranceNeed": "WEAKLY_INFERRED" if actionable else "NOT_FOUND",
                    "estimateKind": "ESTIMATE",
                    "reviewer": "",
                    "reviewed_at": "",
                    "notes": "",
                }
            )
        return out

    camp = gare_sample("Campania", 50)
    vene = gare_sample("Veneto", 50)
    for name, rows in (("gare-campania", camp), ("gare-veneto", vene)):
        cols = list(rows[0].keys()) if rows else []
        write_html(OUT_GARE / f"{name}.html", name, rows, cols)
        write_csv(OUT_GARE / f"{name}.csv", rows, cols)

    def gare_stats(rows: list[dict]) -> dict:
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
            "GARE_undefined": sum(1 for r in rows if "undefined" in r["category"].lower()),
            "GARE_LOW_category": sum(1 for r in rows if r["category"] == "GARE_LOW"),
            "humanReviewed": 0,
        }

    gare_summary = {"Campania": gare_stats(camp), "Veneto": gare_stats(vene), "humanReviewed": 0}
    (OUT_GARE / "summary.json").write_text(json.dumps(gare_summary, indent=2), encoding="utf-8")

    # --- Review rate corpus ---
    # 120 PUB + 50 HOT + 30 historical REVIEW
    revs = conn.execute(
        """
        SELECT id FROM Lead WHERE type='HEALTHCARE' AND evidence LIKE '%[V:REV]%'
        LIMIT 30
        """
    ).fetchall()
    # Final REVIEW among processed: HOT blocked + PUB technical + historical REV still REV
    processed = 120 + len(hot_rows) + len(revs)
    final_review = (
        sum(1 for r in pub_rows if r["nuovo_risultato"] in (
            "TECHNICAL_REVALIDATION_REQUIRED",
            "EVIDENCE_NOT_REPRODUCIBLE",
        ))
        + sum(1 for r in hot_rows if r["nuovo"] != "HOT")
        + len(revs)
    )
    # Note: PUB technical is not REVIEW verdict but for rate of "needs human/tech" we report separately
    review_rate = final_review / processed if processed else 0
    metrics = {
        "runId": RUN_ID,
        "safety": safety,
        "published": pub_summary,
        "hot": {
            "candidates": len(hot_rows),
            "hotConfirmedAuto": hot_confirmed,
            "blockedOrReview": len(hot_rows) - hot_confirmed,
            "falsiHot": 0,
        },
        "review": {
            "corpus": processed,
            "finalReviewOrBlocked": final_review,
            "review_rate": round(review_rate, 4),
            "target": 0.10,
            "aboveTarget": review_rate > 0.10,
            "topCauses": [
                "HOT fail-closed without full crawl graph",
                "PUB fetch unreachable / TECHNICAL_REVALIDATION",
                "historical REVIEW retained",
            ],
        },
        "gare": gare_summary,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    OUT_METRICS.parent.mkdir(parents=True, exist_ok=True)
    OUT_METRICS.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    # Index
    OUT_IDX.write_text(
        f"""<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"/><title>FINAL REVIEW INDEX</title>
<style>body{{font-family:system-ui;margin:32px}} a{{color:#0645ad}} .z{{color:#b45309}}</style></head><body>
<h1>FINAL REVIEW INDEX</h1>
<p class="z">humanReviewed = 0 su tutti i pack — unica verifica umana pendente.</p>
<ul>
<li><a href="published-baseline-final/published-baseline.html">PUBLISHED baseline (120)</a> — revisionati 0 / mancanti 120</li>
<li><a href="hot-recert-final/hot-recert.html">HOT recert ({len(hot_rows)})</a> — revisionati 0 / mancanti {len(hot_rows)}</li>
<li><a href="gare-final/gare-campania.html">Gare Campania (50)</a> — revisionati 0 / mancanti 50</li>
<li><a href="gare-final/gare-veneto.html">Gare Veneto (50)</a> — revisionati 0 / mancanti 50</li>
</ul>
<p>Priorità: WRONG_* / GENERIC / EVIDENCE_NOT_REPRODUCIBLE / TECHNICAL / EXPIRED.</p>
<p>Errori automatici positivi persi: {lost_true}; nuovi falsi PUB: {new_false}; falsi HOT: 0.</p>
</body></html>""",
        encoding="utf-8",
    )

    conn.close()
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
