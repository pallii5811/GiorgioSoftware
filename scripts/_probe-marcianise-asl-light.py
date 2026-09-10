#!/usr/bin/env python3
"""Light Marcianise ASL probe — pages + PDF URLs only, no OCR."""
import json, re
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

UA = {"User-Agent": "Mozilla/5.0 LeadSniper-K3/1.0"}
OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/MARCIANISE_ASL_PROBE_LIGHT.json")

seeds = [
    "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/",
    "https://www.aslcaserta.it/",
    "https://www.aslcaserta.it/amministrazione-trasparente/",
    "https://portalesalute.aslcaserta.it/",
]

def fetch(url, timeout=12):
    try:
        with urlopen(Request(url, headers=UA), timeout=timeout) as r:
            return True, r.geturl(), r.read(1_500_000), r.headers.get("content-type", "")
    except Exception as e:
        return False, url, str(e).encode(), ""

pages, pdfs, seen, q = [], set(), set(), list(dict.fromkeys(seeds))
i = 0
while i < len(q) and i < 20:
    u = q[i]; i += 1
    if u in seen: continue
    seen.add(u)
    ok, final, body, ct = fetch(u)
    if not ok:
        pages.append({"url": u, "ok": False, "error": body.decode()})
        continue
    text = body.decode("utf-8", "ignore") if not isinstance(body, str) else body
    pages.append({
        "url": u, "final": final, "ok": True,
        "has_marcianise": bool(re.search(r"marcianise|guerriero", text, re.I)),
        "has_polizza": bool(re.search(r"polizz|assicur|art\.?\s*10|gelli", text, re.I)),
    })
    for m in re.finditer(r'href=["\']([^"\']+)["\']', text, re.I):
        absu = urljoin(final, m.group(1)).split("#")[0]
        if ".pdf" in absu.lower() and re.search(r"polizz|assicur|rct|rco|parm|gelli|trasparen|risk", absu, re.I):
            pdfs.add(absu)
        if re.search(r"polizz|assicur|trasparen|marcianise|guerriero", absu, re.I) and "aslcaserta" in absu:
            if absu not in seen and len(q) < 30:
                q.append(absu)

hits = [p for p in pages if p.get("has_marcianise") or p.get("has_polizza")]
OUT.write_text(json.dumps({
    "pages_ok": sum(1 for p in pages if p.get("ok")),
    "pages_fail": sum(1 for p in pages if not p.get("ok")),
    "hits": hits,
    "pdf_urls": sorted(pdfs)[:40],
    "pages": pages,
}, ensure_ascii=False, indent=2))
print(json.dumps({
    "pages_ok": sum(1 for p in pages if p.get("ok")),
    "pages_fail": sum(1 for p in pages if not p.get("ok")),
    "hits": len(hits),
    "pdfs": len(pdfs),
    "pdf_sample": sorted(pdfs)[:8],
    "hit_urls": [h.get("url") for h in hits[:8]],
}, ensure_ascii=False, indent=2))
print("WROTE", OUT)
