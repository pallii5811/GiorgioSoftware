#!/usr/bin/env python3
"""Deep PDF / media crawl for Malzoni + Pini + Marcianise official perimeter."""
import hashlib
import json
import re
import socket
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/FINAL_THREE_DEEP.json")
UA = {"User-Agent": "Mozilla/5.0 LeadSniper-K3/1.0"}

REAL_POLICY = re.compile(
    r"polizza\s*(?:n\.?|numero|rc)|numero\s*(?:di\s*)?polizza|compagnia\s+(?:di\s+)?assicur|"
    r"massimale|contraente|assicurato|scadenza\s*(?:polizza|copertura)|"
    r"(?:unipol|generali|allianz|axa|zurich|fondiaria|sai|lloyd|aig|cattolica|reale\s+mutua|itas|helvetia|groupama)",
    re.I,
)
ANALOGOUS = re.compile(r"misura\s+analoga|autoassicuraz|\bparm\b|\bpars\b|piano\s+aziendale\s+di\s+rischio|gestione\s+diretta\s+del\s+rischio", re.I)
NAME_PATS = {
    "malzoni": re.compile(r"malzoni|villa\s+platani", re.I),
    "pini": re.compile(r"villa\s+dei\s+pini|villadeipini|villamaina", re.I),
    "marcianise": re.compile(r"marcianise|anastasia\s+guerriero|guerriero", re.I),
}


def fetch(url, timeout=25, maxb=3_000_000):
    try:
        req = Request(url, headers=UA)
        with urlopen(req, timeout=timeout) as r:
            return {"ok": True, "status": r.status, "url": r.geturl(), "ct": r.headers.get("content-type", ""), "body": r.read(maxb)}
    except Exception as e:
        return {"ok": False, "error": str(e), "url": url}


def host_ok(h):
    try:
        socket.getaddrinfo(h, 443)
        return True
    except Exception:
        return False


def pdf_text(body):
    raw = body.decode("latin-1", "ignore")
    # extract strings between parentheses-ish PDF text operators roughly
    chunks = re.findall(r"\((?:\\.|[^\\)]){4,}\)", raw)
    text = " ".join(c[1:-1] for c in chunks[:2000])
    if len(text) < 200:
        text = re.sub(r"[^\x20-\x7e\n]", " ", raw)
    return text


def same_reg(a, b):
    try:
        ha = ".".join(urlparse(a).hostname.replace("www.", "").split(".")[-2:])
        hb = ".".join(urlparse(b).hostname.replace("www.", "").split(".")[-2:])
        return ha == hb
    except Exception:
        return False


def collect_pdfs_from_html(base, html):
    out = []
    for m in re.finditer(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', html, re.I):
        out.append(urljoin(base, m.group(1)))
    for m in re.finditer(r'https?://[^\s"\'<>]+\.pdf', html, re.I):
        out.append(m.group(0))
    return list(dict.fromkeys(out))


def collect_links(base, html, host_root):
    out = []
    for m in re.finditer(r'href=["\']([^"\']+)["\']', html, re.I):
        u = urljoin(base, m.group(1))
        if not same_reg(u, host_root):
            continue
        if re.search(r"trasparen|amministraz|document|polizz|assicur|parm|pars|rischio|gelli|upload|media|download|allegat", u, re.I):
            out.append(u)
    return list(dict.fromkeys(out))


def classify(url, text, which):
    name_hit = bool(NAME_PATS[which].search(text or "") or NAME_PATS[which].search(url or ""))
    pol = bool(REAL_POLICY.search(text or ""))
    ana = bool(ANALOGOUS.search(text or "") or ANALOGOUS.search(url or ""))
    return {
        "url": url,
        "name_hit": name_hit,
        "policy_signals": pol,
        "analogous_signals": ana,
        "candidate_published": bool(name_hit and pol),
        "snippet": re.sub(r"\s+", " ", (text or ""))[:300],
    }


jobs = [
    {
        "key": "malzoni",
        "id": "cmqktyimz000i111hygme29nh",
        "roots": [
            "https://www.malzoni.it/",
            "https://www.malzoni.it/societa-trasparente/",
            "https://malzonicenter.com/",
            "https://www.malzonicenter.com/",
            "https://www.malzoni.org/",
        ],
        "extra_hosts": ["malzonicenter.com", "www.malzonicenter.com", "malzoni.org", "www.malzoni.org"],
    },
    {
        "key": "pini",
        "id": "cmqklex5q00bh108eq9blm01k",
        "roots": [
            "https://www.villadeipini.com/site/",
            "https://villadeipini.com/villadeipini/",
            "https://www.villadeipini.com/villadeipini/wp-content/uploads/",
            "https://www.malzoni.it/societa-trasparente/",  # same group email/pec
        ],
        "extra_hosts": [],
    },
    {
        "key": "marcianise",
        "id": "cmqoe7vww004aaa3v67rkgl4e",
        "roots": [
            "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/",
            "https://www.aslcaserta.it/",
            "https://www.aslcaserta.it/trasparenza/",
            "https://portalesalute.aslcaserta.it/",
            "https://www.ospedalecaserta.it/",
            "https://www.ospedale.caserta.it/",
        ],
        "extra_hosts": ["aslcaserta.it", "www.aslcaserta.it", "portalesalute.aslcaserta.it", "ospedale.caserta.it"],
    },
]

report = {"jobs": []}
for job in jobs:
    print("===", job["key"])
    pages = []
    pdfs = set()
    queue = list(job["roots"])
    for h in job.get("extra_hosts") or []:
        print(" dns", h, host_ok(h))
        if host_ok(h):
            queue.append(f"https://{h}/")
    seen = set()
    i = 0
    while i < len(queue) and i < 45:
        u = queue[i]
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
        text = body.decode("utf-8", "ignore") if "pdf" not in ct and body[:4] != b"%PDF" else pdf_text(body)
        pages.append({"url": u, "final": final, "status": fr.get("status"), "name": bool(NAME_PATS[job["key"]].search(text))})
        if body[:4] == b"%PDF" or "pdf" in ct or final.lower().endswith(".pdf"):
            pdfs.add(final)
            continue
        # sitemap
        if "xml" in ct or "sitemap" in u:
            for loc in re.findall(r"<loc>\s*([^<]+)\s*</loc>", text, re.I):
                loc = loc.strip()
                if loc.lower().endswith(".pdf"):
                    pdfs.add(loc)
                elif re.search(r"trasparen|polizz|assicur|document|parm|upload", loc, re.I) and loc not in seen:
                    queue.append(loc)
            continue
        html = text
        for p in collect_pdfs_from_html(final, html):
            pdfs.add(p)
        for L in collect_links(final, html, final):
            if L not in seen and len(queue) < 60:
                queue.append(L)
        # wp uploads listing often 403 — try year folders common
        if "uploads" in final:
            for year in ("2025", "2024", "2023", "2022", "2021"):
                queue.append(urljoin(final if final.endswith("/") else final + "/", year + "/"))

    # also known evidence PDFs
    rp = Path(f"/opt/leadsniper-revalidate/data/revalidation/results/{job['id']}.json")
    if rp.exists():
        ev = json.load(open(rp)).get("fullEvidence") or ""
        for m in re.findall(r"https?://[^\s\]<>\"]+\.pdf", ev, re.I):
            pdfs.add(m)

    analyzed = []
    pub = []
    for pu in list(pdfs)[:60]:
        fr = fetch(pu)
        if not fr.get("ok"):
            analyzed.append({"url": pu, "ok": False, "error": fr.get("error")})
            continue
        text = pdf_text(fr["body"])
        c = classify(fr.get("url") or pu, text, job["key"])
        c["ok"] = True
        c["sha256"] = hashlib.sha256(fr["body"]).hexdigest()
        c["bytes"] = len(fr["body"])
        analyzed.append(c)
        if c["candidate_published"]:
            pub.append(c)
            print(" PUB_CAND", c["url"][:120])

    entry = {
        "key": job["key"],
        "leadId": job["id"],
        "pages_checked": len(pages),
        "pdfs_found": len(pdfs),
        "pdfs_analyzed": len(analyzed),
        "published_candidates": pub,
        "analogous_only": [a for a in analyzed if a.get("analogous_signals") and not a.get("policy_signals")],
        "policy_signal_docs": [a for a in analyzed if a.get("policy_signals")],
        "pages_sample": pages[:15],
        "analyzed_sample": analyzed[:20],
    }
    # official website recommendation for marcianise
    if job["key"] == "marcianise":
        entry["recommended_official_website"] = "https://portalesalute.aslcaserta.it/presidi-ospedalieri/p-o-marcianise/"
        entry["parent_org_website"] = "https://www.aslcaserta.it/"
        entry["note"] = "P.O. Anastasia Guerriero — ASL Caserta (not AO Caserta)"
    report["jobs"].append(entry)
    print(" pages", len(pages), "pdfs", len(pdfs), "pub", len(pub), "pol_docs", len(entry["policy_signal_docs"]))

OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print("WROTE", OUT)
