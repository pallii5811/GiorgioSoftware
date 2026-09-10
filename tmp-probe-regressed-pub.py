#!/usr/bin/env python3
"""For the 12 legacy PUBLISHED now HOT: re-fetch legacy policy source + site, strict check."""
import json, re, ssl, sqlite3, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")
DB = "/opt/leadsniper/prisma/dev.db"

cp = json.loads(CP.read_text(encoding="utf-8"))
term = cp.get("terminal") or {}

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
rows = []
for lid, name, web, pf, ev, pcomp, pnum in con.execute(
    "select id, companyName, website, policyFound, evidence, policyCompany, policyNumber "
    "from Lead where type='HEALTHCARE'"
):
    ev = ev or ""
    if not (bool(pf) or "V:PUB" in ev):
        continue
    if term.get(lid, {}).get("processingState") != "HOT_VERIFIED":
        continue
    # legacy policy source urls
    srcs = re.findall(r"fonte polizza (?:PDF|HTML):\s*(\S+)", ev)
    rows.append({
        "id": lid, "company": name, "website": web,
        "legacy_company": pcomp, "legacy_number": pnum,
        "legacy_sources": srcs[:3],
    })

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0 GiorgioRegressAudit/1.0"}

STRONG = re.compile(
    r"polizza\s*n[°º.]?\s*\d[\d./\-]*|polizza\s+\d{4}/\d{2}/\d+|numero\s+(?:di\s+)?polizza|"
    r"scheda\s+di\s+polizza|polizza\s+rc|assicurazione\s+rc|rc\s*sanitar|\bamtrust\b|"
    r"zurich|generali\s+italia|\bunipol\b|reale\s+mutua|allianz|massimale\s*(?:di|:|€)|"
    r"autoassicuraz|gestione\s+diretta\s+del\s+rischio|copertura\s+assicurativa",
    re.I,
)
PDF = re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.I)


def fetch(url, limit=900_000):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            return r.getcode(), r.read(limit), str(r.geturl())
    except Exception as e:
        return None, str(e).encode(), url


def strip_html(b: bytes) -> str:
    s = b.decode("utf-8", "ignore")
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s)


def check(row):
    out = {**row, "hits": [], "matches": [], "pdfs": [], "legacy_src_alive": None}
    w = (row.get("website") or "").strip()
    if w and not w.startswith("http"):
        w = "https://" + w
    origin = "/".join(w.split("/")[:3]) if w else ""

    # 1) legacy policy source still reachable + still has policy?
    for src in row["legacy_sources"]:
        code, body, final = fetch(src)
        if code and 200 <= code < 400:
            out["legacy_src_alive"] = final
            txt = strip_html(body) if b"<html" in body[:4000].lower() or src.lower().endswith((".htm", ".html", "/")) else body.decode("latin-1", "ignore")
            m = STRONG.findall(txt)
            if m:
                out["hits"].append(f"legacy_src:{src[:70]}")
                out["matches"].extend([str(x)[:60] for x in m[:3]])

    # 2) live site pages
    urls = [w] if w else []
    for p in ("/trasparenza", "/amministrazione-trasparenza", "/amministrazione-trasparente",
              "/privacy", "/documenti", "/note-legali", "/chi-siamo"):
        if origin:
            urls.append(origin + p)
    for url in urls:
        code, body, final = fetch(url)
        if not code or not (200 <= code < 400):
            continue
        html = body.decode("utf-8", "ignore")
        txt = strip_html(body)
        for pl in PDF.findall(html)[:20]:
            out["pdfs"].append(urljoin(final, pl))
        m = STRONG.findall(txt)
        if m:
            tag = url.replace(origin, "") or "/"
            out["hits"].append(f"site:{tag}")
            out["matches"].extend([str(x)[:60] for x in m[:3]])
    out["pdfs"] = sorted(set(out["pdfs"]))[:10]
    out["verdict"] = "FALSE_HOT_SUSPECT" if out["hits"] else ("PDF_ONLY_CHECK" if out["pdfs"] else "NO_SIGNAL")
    return out


results = []
with ThreadPoolExecutor(max_workers=6) as ex:
    for fut in as_completed([ex.submit(check, r) for r in rows]):
        results.append(fut.result())

results.sort(key=lambda x: (x["verdict"], x["company"] or ""))
print(json.dumps({
    "regressed_checked": len(results),
    "false_hot_suspect": sum(1 for r in results if r["verdict"] == "FALSE_HOT_SUSPECT"),
    "pdf_only": sum(1 for r in results if r["verdict"] == "PDF_ONLY_CHECK"),
    "no_signal": sum(1 for r in results if r["verdict"] == "NO_SIGNAL"),
}, indent=2))
for r in results:
    print(f"\n[{r['verdict']}] {r['company']}")
    print(f"  id={r['id']} web={r['website']}")
    print(f"  legacy: company={r['legacy_company']} num={r['legacy_number']} src={r['legacy_sources']}")
    print(f"  hits={r['hits'][:5]}")
    print(f"  matches={r['matches'][:5]}")
    print(f"  pdfs={r['pdfs'][:4]}")

Path("/tmp/regressed-pub-audit.json").write_text(
    json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
)
print("\nWROTE /tmp/regressed-pub-audit.json")
