#!/usr/bin/env python3
"""Find ASL Caserta insurance docs mentioning Marcianise / Guerriero."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request, urlopen

UA = {"User-Agent": "Mozilla/5.0 LeadSniper-K3/1.0"}
OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/MARCIANISE_ASL_PROBE.json")
DIR = Path("/tmp/k3-marcianise")
DIR.mkdir(exist_ok=True)

seeds = [
    "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/",
    "https://www.aslcaserta.it/",
    "https://www.aslcaserta.it/amministrazione-trasparente/",
    "https://www.aslcaserta.it/trasparenza/",
    "https://portalesalute.aslcaserta.it/",
    "https://www.aslcaserta.it/servizi/pagine/dettaglio.aspx?id=1",
]

# try common Amministrazione Trasparente paths
for base in ["https://www.aslcaserta.it", "https://portalesalute.aslcaserta.it"]:
    for path in [
        "/amministrazione-trasparente",
        "/trasparenza",
        "/amministrazione-trasparente/disposizioni-generali",
        "/amministrazione-trasparente/bilanci",
        "/amministrazione-trasparente/beni-immobili-e-gestione-patrimonio",
        "/amministrazione-trasparente/servizi-erogati",
        "/amministrazione-trasparente/provvedimenti",
        "/albo-pretorio",
    ]:
        seeds.append(base + path)


def fetch(url, timeout=20):
    try:
        with urlopen(Request(url, headers=UA), timeout=timeout) as r:
            return {"ok": True, "url": r.geturl(), "body": r.read(2_500_000), "ct": r.headers.get("content-type", "")}
    except Exception as e:
        return {"ok": False, "error": str(e), "url": url}


pages = []
pdfs = set()
seen = set()
q = list(dict.fromkeys(seeds))
i = 0
while i < len(q) and i < 40:
    u = q[i]
    i += 1
    if u in seen:
        continue
    seen.add(u)
    fr = fetch(u)
    if not fr.get("ok"):
        pages.append({"url": u, "ok": False, "error": fr.get("error")})
        continue
    final = fr["url"]
    body = fr["body"]
    ct = (fr.get("ct") or "").lower()
    text = body.decode("utf-8", "ignore")
    pages.append(
        {
            "url": u,
            "final": final,
            "status": True,
            "has_marcianise": bool(re.search(r"marcianise|guerriero", text, re.I)),
            "has_polizza": bool(re.search(r"polizz|assicur", text, re.I)),
        }
    )
    if "pdf" in ct or body[:4] == b"%PDF":
        pdfs.add(final)
        continue
    for m in re.finditer(r'href=["\']([^"\']+)["\']', text, re.I):
        absu = urljoin(final, m.group(1))
        if ".pdf" in absu.lower() and re.search(
            r"polizz|assicur|rct|rco|parm|gelli|trasparen|risk|rc-", absu, re.I
        ):
            pdfs.add(absu.split("#")[0])
        if re.search(r"polizz|assicur|trasparen|marcianise|guerriero", absu, re.I):
            if absu not in seen and len(q) < 55 and "aslcaserta" in absu:
                q.append(absu)

print("pages", len(pages), "pdfs", len(pdfs))
for p in pages:
    if p.get("has_marcianise") or p.get("has_polizza"):
        print("PAGE", p)

analyzed = []
for pu in list(pdfs)[:25]:
    fr = fetch(pu)
    if not fr.get("ok"):
        analyzed.append({"url": pu, "error": fr.get("error")})
        continue
    data = fr["body"]
    h = hashlib.sha1(pu.encode()).hexdigest()[:10]
    pdf = DIR / f"{h}.pdf"
    pdf.write_bytes(data)
    txt = DIR / f"{h}.txt"
    subprocess.run(["pdftotext", "-layout", str(pdf), str(txt)], check=False, timeout=60)
    text = txt.read_text("utf-8", errors="ignore") if txt.exists() else ""
    if len(re.sub(r"\s+", "", text)) < 80:
        prefix = str(DIR / h)
        subprocess.run(["pdftoppm", "-png", "-f", "1", "-l", "3", str(pdf), prefix], check=False, timeout=90)
        bits = []
        for png in sorted(DIR.glob(h + "-*.png")):
            r = subprocess.run(
                ["tesseract", str(png), "stdout", "-l", "ita+eng"],
                capture_output=True,
                text=True,
                timeout=180,
            )
            bits.append(r.stdout or "")
        text = "\n".join(bits)
    item = {
        "url": pu,
        "sha256": hashlib.sha256(data).hexdigest(),
        "chars": len(text),
        "mentions_marcianise": bool(re.search(r"marcianise|guerriero", text, re.I)),
        "policy_signals": bool(re.search(r"polizza|massimale|compagnia", text, re.I)),
        "snippet": re.sub(r"\s+", " ", text)[:400],
    }
    analyzed.append(item)
    print(
        "PDF",
        item["mentions_marcianise"],
        item["policy_signals"],
        pu.split("/")[-1][:60],
        item["snippet"][:120],
    )

OUT.write_text(
    json.dumps(
        {
            "recommended_website": "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/",
            "parent": "https://www.aslcaserta.it/",
            "pages": pages,
            "pdfs": analyzed,
            "published_candidates": [
                a
                for a in analyzed
                if a.get("mentions_marcianise") and a.get("policy_signals")
            ],
        },
        ensure_ascii=False,
        indent=2,
    )
)
print("WROTE", OUT, "pub_cands", len([a for a in analyzed if a.get("mentions_marcianise") and a.get("policy_signals")]))
