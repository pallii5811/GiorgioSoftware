#!/usr/bin/env python3
import re
import shutil
from urllib.parse import urljoin
from urllib.request import Request, urlopen

print("pdftoppm", shutil.which("pdftoppm"))
print("tesseract", shutil.which("tesseract"))
for p in ["/usr/bin/tesseract", "/usr/local/bin/tesseract"]:
    import os

    print(p, os.path.exists(p))

seeds = [
    "https://www.malzoni.it/societa-trasparente/",
    "https://malzonicenter.com/",
    "https://malzonicenter.com/trasparenza/",
    "https://www.villadeipini.com/site/",
    "https://villadeipini.com/villadeipini/",
]
for seed in seeds:
    try:
        r = urlopen(Request(seed, headers={"User-Agent": "Mozilla/5.0"}), timeout=25)
        html = r.read().decode("utf-8", "ignore")
        print("SEED", seed, "->", r.geturl(), "len", len(html))
        pdfs = set()
        for m in re.finditer(r'href=["\']([^"\']+)["\']', html, re.I):
            u = urljoin(r.geturl(), m.group(1))
            if ".pdf" in u.lower():
                pdfs.add(u.split("#")[0])
        for m in re.finditer(r"https?://[^\"'<>\s]+\.pdf", html, re.I):
            pdfs.add(m.group(0).split("#")[0])
        print(" pdfs", len(pdfs))
        hits = [
            u
            for u in sorted(pdfs)
            if re.search(
                r"polizz|assicur|parm|pars|rct|rco|obblig|gelli|rc-|massimale|copertura",
                u,
                re.I,
            )
        ]
        print(" hits", len(hits))
        for u in hits:
            print("  HIT", u)
        if len(pdfs) <= 50:
            for u in sorted(pdfs):
                print("  ", u)
    except Exception as e:
        print("SEED FAIL", seed, e)
