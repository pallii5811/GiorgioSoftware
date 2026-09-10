#!/usr/bin/env bash
set -euo pipefail
DIR=/tmp/k3-final-pdfs
mkdir -p "$DIR"
cat > /tmp/k3-pdf-urls.txt <<'EOF'
https://www.malzoni.it/wp-content/uploads/2024/01/Modello-PARM-17.03.2023.pdf
https://www.malzoni.it/wp-content/uploads/2021/09/PARS_Malzoni-Research-Hospital_2026.pdf
https://www.malzoni.it/wp-content/uploads/2021/09/PARS-2025-Malzoni-Research-Hospital-S.p.A..pdf
https://www.malzoni.it/wp-content/uploads/2025/05/carta-dei-servizi-MALZONI-2025-NEW.pdf
https://www.malzoni.it/wp-content/uploads/2024/01/carta-dei-servizi-MALZONI-2023-1.pdf
https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf
https://www.malzoni.it/wp-content/uploads/2021/09/griglia-anac_MALZONI-RESEARCH-HOSPITAL-SPA.pdf
https://malzonicenter.com/
EOF

# Discover more policy-ish PDFs from societa-trasparente + malzonicenter
python3 - <<'PY'
from urllib.request import Request, urlopen
import re
from pathlib import Path
seeds = [
  "https://www.malzoni.it/societa-trasparente/",
  "https://malzonicenter.com/",
  "https://www.malzoni.it/",
]
pdfs = set(Path("/tmp/k3-pdf-urls.txt").read_text().splitlines())
for s in seeds:
  try:
    html = urlopen(Request(s, headers={"User-Agent":"k3"}), timeout=25).read().decode("utf-8","ignore")
  except Exception as e:
    print("seed fail", s, e); continue
  for m in re.finditer(r'https?://[^\"\'\s<>]+\\.pdf', html, re.I):
    pdfs.add(m.group(0))
  for m in re.finditer(r'href=[\"\\']([^\"\\']+\\.pdf[^\"\\']*)[\"\\']', html, re.I):
    from urllib.parse import urljoin
    pdfs.add(urljoin(s, m.group(1)))
# keep policyish
keep=[]
for u in pdfs:
  if re.search(r'polizz|assicur|parm|pars|rct|rco|gelli|trasparen|carta-dei-servizi|anac|obblig', u, re.I) or u in Path('/tmp/k3-pdf-urls.txt').read_text():
    keep.append(u)
Path('/tmp/k3-pdf-urls.txt').write_text('\n'.join(dict.fromkeys(keep)))
print('URLS', len(keep))
for u in keep: print(u)
PY

python3 - <<'PY'
import json, re, subprocess, hashlib
from pathlib import Path
from urllib.request import Request, urlopen

DIR = Path("/tmp/k3-final-pdfs")
DIR.mkdir(exist_ok=True)
URLS = [u for u in Path("/tmp/k3-pdf-urls.txt").read_text().splitlines() if u.startswith("http")]
REAL = re.compile(
    r"polizza\s*(?:n\.?|numero|rc)|numero\s*(?:di\s*)?polizza|compagnia\s+(?:di\s+)?assicur|"
    r"massimale|contraente|assicurato|"
    r"(?:unipolsai|unipol|generali|allianz|axa|zurich|fondiaria|lloyd|cattolica|reale mutua|itas|helvetia|groupama)",
    re.I,
)
ANA = re.compile(r"misura\s+analoga|autoassicuraz|\bPARM\b|\bPARS\b|piano\s+aziendale\s+di\s+rischio|gestione\s+diretta", re.I)
NAME_M = re.compile(r"malzoni|villa\s+platani", re.I)
NAME_P = re.compile(r"villa\s+dei\s+pini|villamaina", re.I)

out = []
for u in URLS[:30]:
    name = hashlib.sha1(u.encode()).hexdigest()[:12] + ".pdf"
    path = DIR / name
    try:
        req = Request(u, headers={"User-Agent": "k3"})
        with urlopen(req, timeout=40) as r:
            data = r.read()
            final = r.geturl()
            ct = r.headers.get("content-type","")
        if "html" in ct.lower() and data[:4] != b"%PDF":
            out.append({"url": u, "skip": "html", "final": final})
            continue
        path.write_bytes(data)
    except Exception as e:
        out.append({"url": u, "error": str(e)})
        print("FAIL", u, e)
        continue
    txt_path = path.with_suffix(".txt")
    subprocess.run(["pdftotext", "-layout", str(path), str(txt_path)], check=False, timeout=90)
    text = txt_path.read_text("utf-8", errors="ignore") if txt_path.exists() else ""
    method = "pdftotext"
    if len(re.sub(r"\s+", "", text)) < 80:
        try:
            prefix = str(DIR / (name + ".p"))
            subprocess.run(["pdftoppm", "-png", "-f", "1", "-l", "3", str(path), prefix], check=False, timeout=120)
            bits = []
            for png in sorted(DIR.glob(name + ".p*.png")):
                r = subprocess.run(["tesseract", str(png), "stdout", "-l", "ita+eng"], capture_output=True, text=True, timeout=180)
                bits.append(r.stdout or "")
            text = "\n".join(bits)
            method = "ocr"
        except Exception as e:
            method = f"ocr_fail:{e}"

    insurers = re.findall(
        r"unipolsai|unipol\s*sai|generali|allianz|axa|zurich|fondiaria\s*sai|cattolica|reale\s+mutua|itas|helvetia|groupama|lloyd'?s?",
        text,
        re.I,
    )
    nums = re.findall(r"(?:polizza|n\.?)\s*[:\.]?\s*([A-Z0-9][A-Z0-9/-]{4,})", text, re.I)
    item = {
        "url": u,
        "final": final,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "method": method,
        "chars": len(text),
        "name_malzoni": bool(NAME_M.search(text) or NAME_M.search(u)),
        "name_pini": bool(NAME_P.search(text) or NAME_P.search(u)),
        "policy_signals": bool(REAL.search(text)),
        "analogous_signals": bool(ANA.search(text) or ANA.search(u)),
        "insurer_hits": insurers[:10],
        "policy_number_hits": nums[:10],
        "snippet": re.sub(r"\s+", " ", text)[:600],
    }
    # strict: structure named + (insurer or policy number or massimale+polizza) AND not pure PARM/PARS without insurer
    has_contract = bool(insurers) or bool(nums) or (
        re.search(r"polizza", text, re.I) and re.search(r"massimale", text, re.I)
    )
    pure_analogous = bool(re.search(r"parm|pars|misura\s+analoga", u + " " + text[:2000], re.I)) and not has_contract
    item["strict_published_malzoni"] = bool(item["name_malzoni"] and has_contract and not pure_analogous)
    item["strict_published_pini"] = bool(item["name_pini"] and has_contract and not pure_analogous)
    out.append(item)
    print("OK", method, "M", item["strict_published_malzoni"], "P", item["strict_published_pini"], "ana", item["analogous_signals"], path.name, u.split("/")[-1][:50])
    print("  ins", insurers[:5], "nums", nums[:3])
    print("  ", item["snippet"][:200])

Path("/opt/leadsniper-revalidate/data/k3-stopship/FINAL_THREE_PDFTEXT.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
print("WROTE", len(out))
PY
