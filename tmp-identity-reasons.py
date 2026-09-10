#!/usr/bin/env python3
"""Which identity gate fails on the 186 IDENTITY retries?"""
import json, re
from collections import Counter
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")
cp = json.loads(CP.read_text(encoding="utf-8"))
rq = cp.get("retryQueue") or {}

GATES = [
    ("NOME_ASSENTE", r"Nome struttura assente"),
    ("CITTA_ASSENTE", r"Citt[àa] attesa"),
    ("CITTA_DIVERSA", r"Citt[àa] sul sito"),
    ("HOST_DIVERSO", r"[Hh]ost .*(?:diverso|non coerente)|non attribuibile"),
    ("NON_ISTITUZIONALE", r"Sito non istituzionale"),
    ("HOTEL_TURISMO", r"hotel/turismo"),
    ("ENTE_PADRE", r"fondazione/ente padre"),
    ("PARCHEGGIATO", r"parcheggiato o in vendita"),
    ("MANUTENZIONE", r"in manutenzione"),
    ("PORTALE_ASL", r"Portale ASL"),
    ("URL_NON_VALIDO", r"URL sito non valido"),
    ("NON_RAGGIUNGIBILE", r"Sito non raggiungibile"),
]

gates = Counter()
no_detail = []
samples = {g: [] for g, _ in GATES}

def host_of(url: str) -> str:
    m = re.match(r"https?://(?:www\.)?([^/]+)", url or "")
    return (m.group(1) if m else "").lower()

def brandish(name: str, host: str) -> bool:
    h = re.sub(r"[^a-z0-9]", "", host.split(".")[0])
    for tok in re.split(r"[^a-zA-Zàèéìòù0-9]+", (name or "").lower()):
        t = re.sub(r"[^a-z0-9]", "", tok)
        if len(t) >= 4 and t in h:
            return True
    return False

brand_ok = 0
total = 0
for lid, v in rq.items():
    blob = f"{v.get('lastReason')} {v.get('lastError')}"
    if "IDENTITY" not in blob.upper():
        continue
    total += 1
    p = RES / f"{lid}.json"
    ev = ""
    name = web = ""
    if p.exists():
        r = json.loads(p.read_text(encoding="utf-8"))
        ev = f"{r.get('fullEvidence') or ''} {r.get('notes') or ''} {r.get('reasonCode') or ''} {r.get('error') or ''}"
        name = r.get("companyName") or ""
        web = r.get("website") or ""
    hit = None
    for gname, pat in GATES:
        if re.search(pat, ev):
            hit = gname
            break
    if hit:
        gates[hit] += 1
        if len(samples[hit]) < 8:
            samples[hit].append((name[:45], web[:45]))
    else:
        gates["UNKNOWN_NO_DETAIL"] += 1
        if len(no_detail) < 8:
            no_detail.append((name[:45], web[:45], ev[:160].replace("\n", " ")))
    if web and brandish(name, host_of(web)):
        brand_ok += 1

print(json.dumps({
    "identity_retries": total,
    "gates": dict(gates.most_common()),
    "host_brand_matches_name": brand_ok,
    "host_brand_pct": round(100 * brand_ok / max(1, total), 1),
}, indent=2, ensure_ascii=False))
for g, rows in samples.items():
    if rows:
        print(f"\n{g}:")
        for n, w in rows:
            print(f"  {n:45s} {w}")
if no_detail:
    print("\nUNKNOWN samples:")
    for n, w, e in no_detail:
        print(f"  {n:40s} {w:40s} ev={e[:120]}")
