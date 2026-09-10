#!/usr/bin/env python3
"""Reclassify spurious relevant/critical → low on targeted frontiers (Python, no better-sqlite3)."""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

CRITICAL_RE = re.compile(
    r"trasparen|polizz|assicur|amministraz|gelli|rischio|rc[to]\b|rco\b|parm|pars|massimale|"
    r"copertura|note-legali|scheda[-_]?di[-_]?polizza|rc\s*sanitar|autoassicura|"
    r"gestione[-_ ]?diretta|fondo[-_ ]?rischi|quietanz|scadenz|decorrenza|documenti[-_ ]?assicur",
    re.I,
)
RELEVANT_RE = re.compile(
    r"(^|/)(chi[-_]?siamo|la[-_]?struttura|struttura|contatti|contatto|privacy|"
    r"cookie(?:-?policy)?|note[-_]?legali|home|index|chi[-_]?e|about|societa[-_]?trasparente)(/|$|\.|-)",
    re.I,
)
LOW_RE = re.compile(
    r"news|blog|comunicat|notizi|medico|dott\.|prestazion|servizi|reparto|specialist|gallery|"
    r"media|evento|pagina|page[=/_\-]\d|wp-content|attachment|categoria|tag/|archiv|feed|rss|"
    r"video|foto|immagine|prenota|agenda|infertil|microbiota|quantiferon|patologia|terapia|"
    r"isac[-_]?test|plac[-_]?test|medicina[-_]?(del[-_]?lavoro|veterinar)|permeabilit",
    re.I,
)


def classify(url: str, src: str) -> str:
    path = url
    try:
        from urllib.parse import urlparse

        path = urlparse(url).path.lower()
    except Exception:
        path = str(url).lower()
    hay = f"{url} {path}"
    if CRITICAL_RE.search(hay):
        return "critical"
    is_pdf = bool(re.search(r"\.pdf(?:$|\?|#)", url, re.I))
    if is_pdf:
        return "low"
    if src in ("seed", "seed_guess", "extra"):
        return "relevant"
    if path in ("/", "") or RELEVANT_RE.search(path):
        return "relevant"
    if LOW_RE.search(hay):
        return "low"
    if src in ("html-link", "playwright", "playwright_xhr", "sitemap", "robots") or src.startswith("sitemap") or not src:
        return "low"
    return "low"


def repair(dir_path: Path) -> dict:
    total = 0
    details = []
    for fp in sorted(dir_path.glob("*.sqlite")):
        con = sqlite3.connect(str(fp))
        rows = con.execute(
            "SELECT id, canonicalUrl, relevance, COALESCE(discoverySource,'') "
            "FROM CrawlFrontierNode WHERE relevance IN ('critical','relevant')"
        ).fetchall()
        n = 0
        for nid, url, rel, src in rows:
            if src in ("seed", "seed_guess", "extra"):
                continue
            nxt = classify(url, src or "html-link")
            if nxt == "low" and nxt != rel:
                con.execute(
                    "UPDATE CrawlFrontierNode SET relevance=?, updatedAt=? WHERE id=?",
                    (nxt, __import__("datetime").datetime.utcnow().isoformat() + "Z", nid),
                )
                n += 1
        con.commit()
        con.close()
        if n:
            details.append({"file": fp.name, "demoted": n})
            total += n
    return {"ok": True, "totalDemoted": total, "details": details}


if __name__ == "__main__":
    import json

    d = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers")
    print(json.dumps(repair(d), indent=2))
