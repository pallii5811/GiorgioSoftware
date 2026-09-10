#!/usr/bin/env python3
"""Deep extract Pini PARM + sibling PDFs for commercial reclassification."""
import hashlib, json, re, subprocess
from pathlib import Path
from urllib.request import Request, urlopen

UA = {"User-Agent": "Mozilla/5.0 LeadSniper-K3/1.0"}
OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/PINI_DEEP.json")
DIR = Path("/tmp/k3-pini"); DIR.mkdir(exist_ok=True)
PID = "cmqklex5q00bh108eq9blm01k"

seeds = [
    "https://villadeipini.com/villadeipini/wp-content/uploads/2025/03/PARM_2025.pdf",
    "https://villadeipini.com/villadeipini/",
    "https://villadeipini.com/",
    "https://www.villadeipini.com/",
    "https://villadeipini.com/villadeipini/amministrazione-trasparente/",
    "https://villadeipini.com/amministrazione-trasparente/",
    "https://villadeipini.com/trasparenza/",
    "https://villadeipini.com/sitemap.xml",
    "https://villadeipini.com/sitemap_index.xml",
    "https://villadeipini.com/wp-sitemap.xml",
    "https://villadeipini.com/robots.txt",
]

# also seed from existing result evidence
rp = Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{PID}.json")
if rp.exists():
    ev = json.loads(rp.read_text()).get("fullEvidence") or ""
    for u in re.findall(r"https?://[^\s\]]+", ev):
        if "pini" in u.lower() or "malzoni" in u.lower():
            seeds.append(u.rstrip(".,);"))

def fetch(url, timeout=25):
    try:
        with urlopen(Request(url, headers=UA), timeout=timeout) as r:
            return True, r.geturl(), r.read(4_000_000), r.headers.get("content-type","")
    except Exception as e:
        return False, url, str(e).encode(), ""

pages, pdfs, seen = [], set(), set()
q = list(dict.fromkeys(seeds))
i = 0
while i < len(q) and i < 35:
    u = q[i]; i += 1
    if u in seen: continue
    seen.add(u)
    ok, final, body, ct = fetch(u)
    if not ok:
        pages.append({"url": u, "ok": False, "error": body.decode(errors="ignore")[:120]})
        continue
    text = body.decode("utf-8", "ignore")
    pages.append({
        "url": u, "final": final, "ok": True,
        "has_assicur": bool(re.search(r"polizz|assicur|autoassicur|gestione\s+diretta|autoritenz|fondo\s+risch|art\.?\s*10|gelli|RCT|RCO", text, re.I)),
        "has_parm": bool(re.search(r"\bPARM\b|\bPARS\b|posizione\s+assicurativa", text, re.I)),
    })
    if "pdf" in (ct or "").lower() or body[:4] == b"%PDF":
        pdfs.add(final); continue
    if u.endswith(".xml") or "sitemap" in u:
        for m in re.finditer(r"<loc>\s*([^<]+)\s*</loc>", text, re.I):
            loc = m.group(1).strip()
            if ".pdf" in loc.lower(): pdfs.add(loc)
            elif "trasparen" in loc.lower() or "assicur" in loc.lower() or "parm" in loc.lower():
                if loc not in seen and len(q) < 50: q.append(loc)
    for m in re.finditer(r'href=["\']([^"\']+)["\']', text, re.I):
        from urllib.parse import urljoin
        absu = urljoin(final, m.group(1)).split("#")[0]
        if ".pdf" in absu.lower():
            pdfs.add(absu)
        if re.search(r"trasparen|polizz|assicur|parm|pars|risk|gelli", absu, re.I) and "pini" in absu.lower():
            if absu not in seen and len(q) < 50: q.append(absu)

analyzed = []
for pu in list(pdfs)[:20]:
    ok, final, data, ct = fetch(pu)
    if not ok:
        analyzed.append({"url": pu, "error": data.decode(errors="ignore")[:100]}); continue
    if data[:4] != b"%PDF" and "pdf" not in (ct or "").lower():
        continue
    h = hashlib.sha1(pu.encode()).hexdigest()[:10]
    pdf = DIR / f"{h}.pdf"; pdf.write_bytes(data)
    txt = DIR / f"{h}.txt"
    subprocess.run(["pdftotext", "-layout", str(pdf), str(txt)], check=False, timeout=60)
    text = txt.read_text("utf-8", errors="ignore") if txt.exists() else ""
    if len(re.sub(r"\s+", "", text)) < 80:
        prefix = str(DIR / h)
        subprocess.run(["pdftoppm", "-png", "-f", "1", "-l", "4", str(pdf), prefix], check=False, timeout=90)
        bits = []
        for png in sorted(DIR.glob(h + "-*.png")):
            r = subprocess.run(["tesseract", str(png), "stdout", "-l", "ita+eng"], capture_output=True, text=True, timeout=120)
            bits.append(r.stdout or "")
        text = "\n".join(bits)
    item = {
        "url": pu,
        "sha256": hashlib.sha256(data).hexdigest(),
        "chars": len(text),
        "self_insurance": bool(re.search(r"auto[\s-]?assicuraz|gestione\s+diretta\s+del\s+rischio|autoritenzione|fondo\s+(?:interno\s+)?rischi", text, re.I)),
        "misura_analoga": bool(re.search(r"misura\s+analoga", text, re.I)),
        "policy": bool(re.search(r"polizza\s+n|compagnia|massimale|\bRCT\b|\bRCO\b|unipol|generali|am\s*trust", text, re.I)),
        "posizione": bool(re.search(r"posizione\s+assicurativa", text, re.I)),
        "snippet": re.sub(r"\s+", " ", text)[:500],
        "citation": None,
    }
    m = re.search(r".{0,60}(?:auto[\s-]?assicuraz|gestione\s+diretta\s+del\s+rischio|autoritenzione|polizza\s+n[°o.]?\s*\S+).{0,80}", text, re.I)
    if m: item["citation"] = m.group(0).strip()
    analyzed.append(item)
    print("PDF", item["self_insurance"], item["policy"], item["misura_analoga"], pu.split("/")[-1][:50], (item["citation"] or item["snippet"])[:100])

# classify recommendation
rec = "KEEP_ANALOGOUS"
reasons = []
for a in analyzed:
    if a.get("self_insurance") and a.get("chars", 0) > 50:
        rec = "SELF_INSURANCE_VERIFIED"; reasons.append(a["url"]); break
    if a.get("policy") and a.get("chars", 0) > 50:
        rec = "PUBLISHED_CANDIDATE"; reasons.append(a["url"])

OUT.write_text(json.dumps({
    "leadId": PID,
    "pages": pages,
    "pdfs": analyzed,
    "recommendation": rec,
    "reasons": reasons,
    "commercial_if": rec in ("SELF_INSURANCE_VERIFIED", "PUBLISHED_CANDIDATE"),
}, ensure_ascii=False, indent=2))
print("REC", rec, "pdfs", len(analyzed), "WROTE", OUT)
