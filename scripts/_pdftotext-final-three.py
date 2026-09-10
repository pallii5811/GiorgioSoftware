#!/usr/bin/env python3
import hashlib
import json
import re
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

DIR = Path("/tmp/k3-final-pdfs")
DIR.mkdir(exist_ok=True)
URLS = [
    "https://www.malzoni.it/wp-content/uploads/2024/01/Modello-PARM-17.03.2023.pdf",
    "https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf",
    "https://www.malzoni.it/wp-content/uploads/2021/09/PARS-2025-Malzoni-Research-Hospital-S.p.A..pdf",
    "https://www.malzoni.it/wp-content/uploads/2025/05/carta-dei-servizi-MALZONI-2025-NEW.pdf",
    "https://www.malzoni.it/wp-content/uploads/2024/01/carta-dei-servizi-MALZONI-2023-1.pdf",
    "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf",
    "https://www.malzoni.it/wp-content/uploads/2021/09/griglia-anac_MALZONI-RESEARCH-HOSPITAL-SPA.pdf",
]
for seed in ["https://www.malzoni.it/societa-trasparente/", "https://malzonicenter.com/"]:
    try:
        html = urlopen(Request(seed, headers={"User-Agent": "k3"}), timeout=25).read().decode(
            "utf-8", "ignore"
        )
        from urllib.parse import urljoin

        for m in re.finditer(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', html, re.I):
            u = urljoin(seed, m.group(1))
            if re.search(r"polizz|assicur|parm|pars|rct|carta-dei-servizi|obblig|gelli|rc-", u, re.I):
                URLS.append(u)
    except Exception as e:
        print("seed fail", seed, e)

URLS = list(dict.fromkeys(URLS))
print("URLS", len(URLS))
for u in URLS:
    print(" ", u)

NAME_M = re.compile(r"malzoni|villa\s+platani", re.I)
NAME_P = re.compile(r"villa\s+dei\s+pini|villamaina", re.I)
# Current coverage language, not historical table alone
CURRENT_POL = re.compile(
    r"(?:polizza\s+(?:in\s+corso|attiva|vigente|corrente)|copertura\s+assicurativa\s+attiva|"
    r"compagnia\s+assicurativa\s*[:\-]|massimale\s*(?:di\s+)?(?:€|euro)|"
    r"polizza\s+n\.?\s*[A-Z0-9])",
    re.I,
)
NO_POL = re.compile(
    r"non\s+ha\s+sottoscritto\s+alcuna\s+polizza|assenza\s+di\s+polizza|misura\s+analoga|"
    r"in\s+luogo\s+della\s+polizza|autoassicurazione",
    re.I,
)
INS = re.compile(
    r"unipolsai|unipol\s*sai|\bgenerali\b|\ballianz\b|\baxa\b|\bzurich\b|fondiaria\s*sai|"
    r"\bcattolica\b|reale\s+mutua|\bitas\b|\bhelvetia\b|\bgroupama\b|lloyd",
    re.I,
)


def extract_text(path: Path, data: bytes) -> tuple[str, str]:
    txt_path = path.with_suffix(".txt")
    subprocess.run(["pdftotext", "-layout", str(path), str(txt_path)], check=False, timeout=90)
    text = txt_path.read_text("utf-8", errors="ignore") if txt_path.exists() else ""
    if len(re.sub(r"\s+", "", text)) >= 80:
        return text, "pdftotext"
    # optional OCR if tools exist
    tess = Path("/usr/bin/tesseract")
    pdftoppm = Path("/usr/bin/pdftoppm")
    if not tess.exists() or not pdftoppm.exists():
        return text, "pdftotext_thin"
    prefix = str(DIR / (path.stem + ".p"))
    subprocess.run(
        ["pdftoppm", "-png", "-f", "1", "-l", "3", str(path), prefix], check=False, timeout=120
    )
    bits = []
    for png in sorted(DIR.glob(path.stem + ".p*.png")):
        r = subprocess.run(
            [str(tess), str(png), "stdout", "-l", "ita+eng"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        bits.append(r.stdout or "")
    return "\n".join(bits), "ocr"


out = []
for u in URLS:
    name = hashlib.sha1(u.encode()).hexdigest()[:12] + ".pdf"
    path = DIR / name
    try:
        with urlopen(Request(u, headers={"User-Agent": "k3"}), timeout=40) as r:
            data = r.read()
            final = r.geturl()
            ct = r.headers.get("content-type", "")
        if "html" in ct.lower() and not data.startswith(b"%PDF"):
            print("skip html", u)
            continue
        path.write_bytes(data)
    except Exception as e:
        print("FAIL", u, e)
        out.append({"url": u, "error": str(e)})
        continue

    text, method = extract_text(path, data)
    insurers = INS.findall(text)
    is_parmish = bool(re.search(r"parm|pars|misura\s+analoga", u + " " + text[:2500], re.I))
    denies = bool(NO_POL.search(text))
    current = bool(CURRENT_POL.search(text))
    # Published ONLY if current policy language AND not a PARM/PARS that denies/substitutes policy
    strict_m = bool(
        (NAME_M.search(text) or NAME_M.search(u))
        and current
        and not (is_parmish and (denies or not current))
        and not (is_parmish and denies)
    )
    # Even stricter gate used for promotion decision:
    promote_m = bool(
        (NAME_M.search(text) or NAME_M.search(u))
        and current
        and bool(insurers)
        and not is_parmish
        and not denies
    )
    promote_p = bool(
        (NAME_P.search(text) or NAME_P.search(u))
        and current
        and bool(insurers)
        and not is_parmish
        and not denies
    )
    item = {
        "url": u,
        "final": final,
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "method": method,
        "chars": len(text),
        "name_malzoni": bool(NAME_M.search(text) or NAME_M.search(u)),
        "name_pini": bool(NAME_P.search(text) or NAME_P.search(u)),
        "is_parmish": is_parmish,
        "denies_policy": denies,
        "current_policy_language": current,
        "insurer_hits": insurers[:10],
        "promote_malzoni": promote_m,
        "promote_pini": promote_p,
        "snippet": re.sub(r"\s+", " ", text)[:800],
    }
    out.append(item)
    print(
        "OK",
        method,
        "promoteM",
        promote_m,
        "promoteP",
        promote_p,
        "parm",
        is_parmish,
        "deny",
        denies,
        "cur",
        current,
        u.split("/")[-1][:55],
    )
    print("  ins", insurers[:5])
    print(" ", item["snippet"][:240])

Path("/opt/leadsniper-revalidate/data/k3-stopship/FINAL_THREE_PDFTEXT.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=2)
)
print(
    "SUMMARY promote_m",
    sum(1 for x in out if x.get("promote_malzoni")),
    "promote_p",
    sum(1 for x in out if x.get("promote_pini")),
)
