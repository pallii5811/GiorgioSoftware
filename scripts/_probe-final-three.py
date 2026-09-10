#!/usr/bin/env python3
"""Direct acquisition probe for Malzoni / Pini / Marcianise."""
import hashlib
import json
import re
import socket
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/FINAL_THREE_PROBE.json")
UA = {"User-Agent": "LeadSniper-K3-FinalThree/1.0"}


def sameish(a, b):
    try:
        ha = urlparse(a).hostname.replace("www.", "")
        hb = urlparse(b).hostname.replace("www.", "")
        return ha == hb or ha.endswith("." + hb) or hb.endswith("." + ha)
    except Exception:
        return False


def dns_ok(host):
    try:
        socket.getaddrinfo(host, 443)
        return True
    except Exception:
        return False


def fetch(url, timeout=20):
    try:
        req = Request(url, headers=UA)
        with urlopen(req, timeout=timeout) as r:
            body = r.read(2_500_000)
            return {
                "ok": True,
                "status": r.status,
                "url": r.geturl(),
                "ct": r.headers.get("content-type", ""),
                "body": body,
            }
    except Exception as e:
        return {"ok": False, "error": str(e), "url": url}


def text_from(body, ct):
    if body[:4] == b"%PDF" or (ct and "pdf" in ct.lower()):
        try:
            raw = body.decode("latin-1", "ignore")
            return re.sub(r"[^\x20-\x7e\n]", " ", raw)[:12000]
        except Exception:
            return ""
    try:
        return body.decode("utf-8", "ignore")
    except Exception:
        return body.decode("latin-1", "ignore")


POLICYISH = re.compile(
    r"polizz|assicur|rct|rco|massimale|compagnia|legge.?24|gelli|parm|pars|trasparen|amministraz|documento",
    re.I,
)
ANALOGOUS_ONLY = re.compile(
    r"misura\s+analoga|autoassicuraz|parm|piano\s+di\s+gestione\s+del\s+rischio|gestione\s+diretta",
    re.I,
)
REAL_POLICY = re.compile(
    r"polizza\s*(?:n\.?|numero|rc)|numero\s+polizza|compagnia\s+(?:di\s+)?assicur|massimale|scadenza|"
    r"(?:unipol|generali|allianz|axa|zurich|fondiaria|sai|lloyd|aig|cattolica|reale\s+mutua|itas)",
    re.I,
)
PDF_HREF = re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.I)
LINK_HREF = re.compile(r'href=["\']([^"\']+)["\']', re.I)

TARGETS = [
    {
        "id": "cmqktyimz000i111hygme29nh",
        "company": "Casa Di Cura Malzoni Villa Platani Spa",
        "website": "http://www.malzoni.it/",
        "aliases": ["malzoni", "villa platani", "malzoni research", "casa di cura malzoni"],
        "seeds": [
            "https://www.malzoni.it/",
            "https://malzoni.it/",
            "https://www.malzoni.it/societa-trasparente/",
            "https://www.malzoni.it/amministrazione-trasparente/",
            "https://www.malzoni.it/trasparenza/",
            "https://www.malzoni.it/note-legali/",
            "https://www.malzoni.it/assicurazione/",
            "https://www.malzoni.it/documenti/",
            "https://www.malzoni.it/sitemap_index.xml",
            "https://www.malzoni.it/sitemap.xml",
            "https://www.malzoni.it/robots.txt",
        ],
    },
    {
        "id": "cmqklex5q00bh108eq9blm01k",
        "company": "Villa Dei Pini Casa di Cura Privata S.p.a.",
        "website": "https://www.villadeipini.com/site/",
        "aliases": ["villa dei pini", "villadeipini", "villamaina", "casa di cura privata"],
        "seeds": [
            "https://www.villadeipini.com/",
            "https://www.villadeipini.com/site/",
            "https://villadeipini.com/",
            "https://www.villadeipini.com/villadeipini/",
            "https://www.villadeipini.com/site/trasparenza/",
            "https://www.villadeipini.com/site/amministrazione-trasparente/",
            "https://www.villadeipini.com/site/societa-trasparente/",
            "https://www.villadeipini.com/site/documenti/",
            "https://www.villadeipini.com/site/assicurazione/",
            "https://villadeipini.com/sitemap_index.xml",
            "https://www.villadeipini.com/robots.txt",
            "https://villadeipini.com/villadeipini/wp-content/uploads/",
        ],
    },
    {
        "id": "cmqoe7vww004aaa3v67rkgl4e",
        "company": "Ospedale di Marcianise",
        "website": None,
        "aliases": [
            "marcianise",
            "ospedale di marcianise",
            "ospedale marcianise",
            "ao caserta",
            "azienda ospedaliera caserta",
            "sant'anna e san sebastiano",
        ],
        "seeds": [
            "https://www.ospedalecaserta.it/",
            "https://www.aocaserta.it/",
            "https://www.ospedalecaserta.it/ospedale-di-marcianise/",
            "https://www.ospedalecaserta.it/sedi/",
            "https://www.ospedalecaserta.it/trasparenza/",
            "https://www.aslnapoli2nord.it/",
            "https://www.aslnapoli2nord.it/?s=marcianise",
        ],
        "guess_hosts": [
            "ospedalemarcianise.it",
            "www.ospedalemarcianise.it",
            "ospedale-marcianise.it",
            "marcianiseospedale.it",
            "aocaserta.it",
            "www.aocaserta.it",
            "ospedalecaserta.it",
            "www.ospedalecaserta.it",
            "presidiomarcianise.it",
        ],
    },
]


def classify_doc(url, text, aliases, company):
    low = (text or "").lower()
    name_hit = any(a.lower() in low for a in aliases + [company] if len(a) >= 5)
    has_policy = bool(REAL_POLICY.search(text or ""))
    analogous = bool(ANALOGOUS_ONLY.search(text or "") or ANALOGOUS_ONLY.search(url or ""))
    # Published candidate: structure named + real policy signals (company/number/massimale/insurer)
    # Analogous-only PARM without insurer/number is NOT published
    candidate = bool(name_hit and has_policy)
    return {
        "url": url,
        "name_hit": name_hit,
        "has_real_policy_signals": has_policy,
        "analogous_signals": analogous,
        "candidate_published": candidate,
        "snippet": re.sub(r"\s+", " ", text or "")[:280],
    }


results = []
for t in TARGETS:
    item = {
        "leadId": t["id"],
        "company": t["company"],
        "website": t["website"],
        "dns_guesses": [],
        "pages": [],
        "pdfs": [],
        "published_candidates": [],
        "official_site_candidates": [],
        "sitemap_pdfs": [],
    }
    seeds = list(t.get("seeds") or [])
    for h in t.get("guess_hosts") or []:
        ok = dns_ok(h)
        item["dns_guesses"].append({"host": h, "dns": ok})
        if ok:
            seeds.extend([f"https://{h}/", f"http://{h}/"])

    seen = set()
    pdf_urls = set()
    i = 0
    while i < len(seeds) and i < 60:
        seed = seeds[i]
        i += 1
        if seed in seen:
            continue
        seen.add(seed)
        fr = fetch(seed)
        if not fr.get("ok"):
            item["pages"].append({"url": seed, "ok": False, "error": fr.get("error")})
            continue
        final = fr["url"]
        body = fr["body"]
        ct = fr.get("ct") or ""
        text = text_from(body, ct)
        name_on = any(a.lower() in text.lower() for a in t["aliases"] if len(a) >= 5)
        page_info = {
            "url": seed,
            "final": final,
            "status": fr.get("status"),
            "policyish": bool(POLICYISH.search(final) or POLICYISH.search(text[:4000])),
            "name_on_page": name_on,
        }
        item["pages"].append(page_info)
        if name_on and "html" in (ct.lower() + " html"):
            item["official_site_candidates"].append(final)

        # sitemap locs
        if "xml" in ct.lower() or seed.endswith(".xml") or "sitemap" in seed:
            for loc in re.findall(r"<loc>\s*([^<]+)\s*</loc>", text, re.I):
                loc = loc.strip()
                if loc.lower().endswith(".pdf"):
                    pdf_urls.add(loc)
                    item["sitemap_pdfs"].append(loc)
                elif POLICYISH.search(loc) and loc not in seen and sameish(loc, final):
                    seeds.append(loc)

        htmlish = "html" in ct.lower() or b"<a " in body[:5000].lower() or b"href=" in body[:8000].lower()
        if htmlish:
            html = text
            base_host = urlparse(final).hostname or ""
            for m in LINK_HREF.finditer(html):
                absu = urljoin(final, m.group(1))
                if not sameish(absu, final):
                    continue
                if POLICYISH.search(absu) and absu not in seen and len(seeds) < 80:
                    seeds.append(absu)
            for m in PDF_HREF.finditer(html):
                pdf_urls.add(urljoin(final, m.group(1)))

        if final.lower().endswith(".pdf") or "pdf" in ct.lower() or body[:4] == b"%PDF":
            pdf_urls.add(final)

    RD = Path("/opt/leadsniper-revalidate/data/revalidation/results") / f"{t['id']}.json"
    if RD.exists():
        row = json.load(open(RD))
        ev = row.get("fullEvidence") or ""
        for u in re.findall(r"https?://[^\s\]<>\"]+\.pdf", ev, re.I):
            pdf_urls.add(u)
        # also list frontier PDF evidence if any
        for fp in row.get("frontierPaths") or []:
            p = Path(fp)
            if not p.exists():
                continue
            try:
                import sqlite3

                con = sqlite3.connect(str(p))
                for (u,) in con.execute(
                    "select canonicalUrl from CrawlFrontierNode where resourceType='pdf' or canonicalUrl like '%.pdf%'"
                ):
                    pdf_urls.add(u)
                con.close()
            except Exception:
                pass

    for pu in list(pdf_urls)[:50]:
        fr = fetch(pu)
        if not fr.get("ok"):
            item["pdfs"].append({"url": pu, "ok": False, "error": fr.get("error")})
            continue
        text = text_from(fr["body"], fr.get("ct") or "")
        c = classify_doc(fr.get("url") or pu, text, t["aliases"], t["company"])
        c["ok"] = True
        c["content_sha256"] = hashlib.sha256(fr["body"]).hexdigest()
        c["bytes"] = len(fr["body"])
        item["pdfs"].append(c)
        if c["candidate_published"]:
            item["published_candidates"].append(c)

    # dedupe official
    item["official_site_candidates"] = list(dict.fromkeys(item["official_site_candidates"]))
    results.append(item)
    print("===", t["company"])
    print(" dns", item["dns_guesses"])
    print(" official", item["official_site_candidates"][:8])
    print(" pages_ok", sum(1 for p in item["pages"] if p.get("status")), "pdfs", len(item["pdfs"]))
    print(" published_cands", len(item["published_candidates"]))
    for c in item["published_candidates"][:8]:
        print("  ", c["url"][:110], "name=", c["name_hit"], "pol=", c["has_real_policy_signals"], "ana=", c["analogous_signals"])

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"targets": results}, ensure_ascii=False, indent=2))
print("WROTE", OUT)
