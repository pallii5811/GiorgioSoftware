#!/usr/bin/env python3
"""Marcianise perimeter: ASL portal + AO Caserta + common AT paths + browser-free."""
import hashlib, json, re, subprocess
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"}
OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/MARCIANISE_DEEP.json")
DIR = Path("/tmp/k3-marc"); DIR.mkdir(exist_ok=True)
MID = "cmqoe7vww004aaa3v67rkgl4e"

seeds = [
    "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/",
    "https://portalesalute.aslcaserta.it/presidi-ospedalieri/",
    "https://portalesalute.aslcaserta.it/",
    "https://www.aslcaserta.it/",
    "https://aslcaserta.it/",
    "http://www.aslcaserta.it/",
    "https://www.aslcaserta.it/page/amministrazione-trasparente",
    "https://www.aslcaserta.it/amministrazione-trasparente",
    "https://trasparenza.aslcaserta.it/",
    "https://www.aslnapoli2nord.it/",  # no - wrong
    "https://www.aorncaserta.it/",
    "https://www.aorncaserta.it/amministrazione-trasparente/",
    "https://www.aocaserta.it/",
    "https://www.santannaeasansebastiano.it/",
    "https://www.santannaeasansebastiano.it/amministrazione-trasparente/",
]

# from DB / result
import sqlite3
con = sqlite3.connect("/opt/leadsniper-revalidate/shadow-revalidate.db")
row = con.execute("select companyName, website, phone, evidence from Lead where id=?", (MID,)).fetchone()
con.close()
print("DB", row[0] if row else None, row[1] if row else None)
if row and row[3]:
    for u in re.findall(r"https?://[^\s\]]+", row[3]):
        seeds.append(u.rstrip(".,);"))

rp = Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{MID}.json")
if rp.exists():
    r = json.loads(rp.read_text())
    print("RESULT", r.get("processingState"), r.get("website"), r.get("reasonCode"))
    for u in re.findall(r"https?://[^\s\]]+", r.get("fullEvidence") or ""):
        seeds.append(u.rstrip(".,);"))

def fetch(url, timeout=15):
    try:
        with urlopen(Request(url, headers=UA), timeout=timeout) as r:
            return True, r.geturl(), r.read(2_000_000), r.headers.get("content-type","")
    except Exception as e:
        return False, url, str(e).encode(), ""

pages, pdfs, seen = [], set(), set()
q = list(dict.fromkeys(seeds))
i = 0
while i < len(q) and i < 40:
    u = q[i]; i += 1
    if u in seen: continue
    seen.add(u)
    ok, final, body, ct = fetch(u)
    if not ok:
        pages.append({"url": u, "ok": False, "error": body.decode(errors="ignore")[:140]})
        continue
    text = body.decode("utf-8", "ignore")
    hit = {
        "url": u, "final": final, "ok": True,
        "marcianise": bool(re.search(r"marcianise|guerriero|anastasia", text, re.I)),
        "assicur": bool(re.search(r"polizz|assicur|autoassicur|parm|pars|art\.?\s*10|gelli", text, re.I)),
    }
    pages.append(hit)
    if hit["marcianise"] or hit["assicur"]:
        print("PAGE", hit["marcianise"], hit["assicur"], final[:90])
    if body[:4] == b"%PDF" or "pdf" in (ct or "").lower():
        pdfs.add(final); continue
    for m in re.finditer(r'href=["\']([^"\']+)["\']', text, re.I):
        absu = urljoin(final, m.group(1)).split("#")[0]
        if ".pdf" in absu.lower() and re.search(r"polizz|assicur|parm|pars|gelli|rct|rco|trasparen|risk", absu, re.I):
            pdfs.add(absu)
        if re.search(r"marcianise|guerriero|trasparen|polizz|assicur|parm|albo", absu, re.I):
            if ("aslcaserta" in absu or "aorn" in absu or "santanna" in absu or "portalesalute" in absu) and absu not in seen and len(q) < 55:
                q.append(absu)

analyzed = []
for pu in list(pdfs)[:15]:
    ok, final, data, ct = fetch(pu, timeout=20)
    if not ok or data[:4] != b"%PDF":
        analyzed.append({"url": pu, "error": "fetch/notpdf"}); continue
    h = hashlib.sha1(pu.encode()).hexdigest()[:10]
    pdf = DIR / f"{h}.pdf"; pdf.write_bytes(data)
    txt = DIR / f"{h}.txt"
    subprocess.run(["pdftotext", "-layout", str(pdf), str(txt)], check=False, timeout=45)
    text = txt.read_text("utf-8", errors="ignore") if txt.exists() else ""
    item = {
        "url": pu,
        "sha256": hashlib.sha256(data).hexdigest(),
        "chars": len(text),
        "marcianise": bool(re.search(r"marcianise|guerriero", text, re.I)),
        "policy": bool(re.search(r"polizza|massimale|compagnia|\bRCT\b", text, re.I)),
        "self_ins": bool(re.search(r"auto[\s-]?assicuraz|gestione\s+diretta", text, re.I)),
        "snippet": re.sub(r"\s+", " ", text)[:300],
    }
    analyzed.append(item)
    print("PDF", item["marcianise"], item["policy"], item["self_ins"], pu.split("/")[-1][:50])

ok_pages = [p for p in pages if p.get("ok")]
marc_pages = [p for p in ok_pages if p.get("marcianise")]
pub = [a for a in analyzed if a.get("marcianise") and (a.get("policy") or a.get("self_ins"))]

# recommendation
if pub:
    rec = "SELF_INSURANCE_VERIFIED" if any(a.get("self_ins") for a in pub) else "PUBLISHED_CANDIDATE"
elif marc_pages and not pdfs:
    rec = "RETRY_PENDING_NO_DOCS"
elif not ok_pages:
    rec = "RETRY_PENDING_UNREACHABLE"
else:
    rec = "RETRY_PENDING_INCOMPLETE"

OUT.write_text(json.dumps({
    "leadId": MID,
    "db_website": row[1] if row else None,
    "pages_ok": len(ok_pages),
    "pages_fail": sum(1 for p in pages if not p.get("ok")),
    "marcianise_pages": [p["url"] for p in marc_pages],
    "pdfs": analyzed,
    "published_candidates": pub,
    "recommendation": rec,
}, ensure_ascii=False, indent=2))
print("REC", rec, "WROTE", OUT)
