#!/usr/bin/env python3
"""Full matrix for Sant'Arsenio TECHNICAL_BLOCKED (30) + EXCLUDED."""
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

FP = "/opt/leadsniper-revalidate/data/revalidation/frontiers/reval-p1-cmqp7cqya00011q5bkqf3ox8q-1784767046766.sqlite"
OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/SANT_ARSENIO_FRONTIER_AUDIT.json")
SITE = "santarseniomedicalcentre.it"

RELEVANT_KW = re.compile(
    r"trasparen|amministraz|document|polizz|assicur|risk|parm|gelli|rc\b|responsabilit|privacy|cookie",
    re.I,
)
ASSET_RE = re.compile(r"\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp4|webp|map)(\?|$)", re.I)
SOCIAL_RE = re.compile(r"(facebook|twitter|instagram|linkedin|youtube|tiktok|whatsapp)\.", re.I)
TRACK_RE = re.compile(r"(google-analytics|gtag|doubleclick|hotjar|cookiebot|googletagmanager)", re.I)


def host_of(u):
    try:
        return (urlparse(u).hostname or "").lower()
    except Exception:
        return ""


def is_internal(h):
    h = h.replace("www.", "")
    return h == SITE or h.endswith("." + SITE)


def classify(url, host, status, err, relevance, exclusion):
    hints = []
    url_l = (url or "").lower()
    err_l = (err or "").lower()
    relevant_kw = bool(RELEVANT_KW.search(url or ""))
    relevant = relevance in ("critical", "relevant") or relevant_kw
    necessary = relevant and relevance != "excluded"
    eliminable = False
    elim_why = None

    if ASSET_RE.search(url or "") or (exclusion and "asset" in (exclusion or "").lower()):
        hints.append("asset/non HTML")
        eliminable, elim_why = True, "asset"
        necessary = False
    if SOCIAL_RE.search(url or "") or SOCIAL_RE.search(host or ""):
        hints.append("social")
        eliminable, elim_why = True, "social"
        necessary = False
        relevant = False
    if TRACK_RE.search(url or ""):
        hints.append("tracking")
        eliminable, elim_why = True, "tracking"
        necessary = False
        relevant = False
    if host and not is_internal(host):
        hints.append("host esterno")
        if not relevant_kw:
            eliminable, elim_why = True, "external_irrelevant"
            necessary = False

    if status in (404, 410):
        hints.append("404/410")
        if not relevant_kw:
            eliminable, elim_why = True, "permanent_dead"
    if status == 403:
        hints.append("403/WAF")
    if status and int(status) >= 500 if str(status).isdigit() else False:
        hints.append("5xx")

    if "dns" in err_l or "enotfound" in err_l or "getaddrinfo" in err_l:
        hints.append("DNS")
    if "tls" in err_l or "cert" in err_l or "ssl" in err_l or "certificate" in err_l:
        hints.append("TLS")
    if "timeout" in err_l or "etimedout" in err_l or "aborted" in err_l:
        hints.append("timeout")
    if "redirect" in err_l and "loop" in err_l:
        hints.append("redirect loop")
    if "browser" in err_l or "playwright" in err_l:
        hints.append("browser failure")
    if "sitemap" in err_l or "sitemap" in (exclusion or "").lower():
        hints.append("sitemap URL invalido")
    if "waf" in err_l or "cloudflare" in err_l or "blocked" in err_l:
        hints.append("403/WAF")
    if "techn" in err_l or "TECHNICAL" in (err or ""):
        hints.append("TECHNICAL_BLOCKED")
    if url_l.endswith(".pdf"):
        hints.append("PDF")
    if "dup" in (exclusion or "").lower() or "canonical" in (exclusion or "").lower():
        hints.append("URL duplicati")
        eliminable, elim_why = True, "duplicate"

    if not hints:
        hints.append("unclassified")

    # never eliminate policy-ish URLs
    protect = bool(
        re.search(
            r"trasparen|amministraz|document|polizz|assicur|risk|parm|gelli",
            url or "",
            re.I,
        )
    )
    if protect:
        eliminable = False
        elim_why = None
        necessary = True
        relevant = True

    return {
        "relevant": relevant,
        "necessary_for_HOT": necessary,
        "eliminable": eliminable,
        "elim_why": elim_why,
        "root_hints": hints,
        "internal_external": "internal" if is_internal(host) else "external",
    }


con = sqlite3.connect(FP)
con.row_factory = sqlite3.Row
run = dict(con.execute("select * from CrawlRun").fetchone())
nodes = [dict(r) for r in con.execute("select * from CrawlFrontierNode").fetchall()]
con.close()

matrix = []
for n in nodes:
    if n["state"] not in ("TECHNICAL_BLOCKED", "FAILED", "RETRY_PENDING") and not (
        n["state"] == "EXCLUDED" and n.get("relevance") in ("critical", "relevant")
    ):
        # still include EXCLUDED for audit completeness if marked relevant wrongly
        if n["state"] != "TECHNICAL_BLOCKED":
            continue
    url = n.get("canonicalUrl") or ""
    host = host_of(url)
    meta = classify(
        url,
        host,
        n.get("httpStatus"),
        n.get("lastError") or "",
        n.get("relevance") or "",
        n.get("exclusionReason") or "",
    )
    matrix.append(
        {
            "url": url,
            "relevant": meta["relevant"],
            "host": host,
            "resource_type": n.get("resourceType"),
            "http_status": n.get("httpStatus"),
            "error": n.get("lastError"),
            "retries": n.get("retryCount"),
            "fallback_http_browser": None,
            "discovery_source": n.get("discoverySource"),
            "duplicate_or_canonical": None,
            "internal_external": meta["internal_external"],
            "necessary_for_HOT": meta["necessary_for_HOT"],
            "state": n["state"],
            "relevance": n.get("relevance"),
            "exclusionReason": n.get("exclusionReason"),
            "contentType": n.get("contentType"),
            "eliminable": meta["eliminable"],
            "elim_why": meta["elim_why"],
            "root_hints": meta["root_hints"],
        }
    )

# Also dump ALL technical blocked explicitly if filter missed
if len([m for m in matrix if m["state"] == "TECHNICAL_BLOCKED"]) < 30:
    matrix = []
    for n in nodes:
        if n["state"] != "TECHNICAL_BLOCKED":
            continue
        url = n.get("canonicalUrl") or ""
        host = host_of(url)
        meta = classify(url, host, n.get("httpStatus"), n.get("lastError") or "", n.get("relevance") or "", n.get("exclusionReason") or "")
        matrix.append(
            {
                "url": url,
                "relevant": meta["relevant"],
                "host": host,
                "resource_type": n.get("resourceType"),
                "http_status": n.get("httpStatus"),
                "error": n.get("lastError"),
                "retries": n.get("retryCount"),
                "fallback_http_browser": None,
                "discovery_source": n.get("discoverySource"),
                "duplicate_or_canonical": None,
                "internal_external": meta["internal_external"],
                "necessary_for_HOT": meta["necessary_for_HOT"],
                "state": n["state"],
                "relevance": n.get("relevance"),
                "exclusionReason": n.get("exclusionReason"),
                "contentType": n.get("contentType"),
                "eliminable": meta["eliminable"],
                "elim_why": meta["elim_why"],
                "root_hints": meta["root_hints"],
            }
        )

# group by first root hint + error prefix
err_counter = Counter((m.get("error") or "")[:120] for m in matrix)
host_counter = Counter(m.get("host") for m in matrix)
src_counter = Counter(m.get("discovery_source") for m in matrix)
rel_counter = Counter(m.get("relevance") for m in matrix)
status_counter = Counter(m.get("http_status") for m in matrix)
hint_counter = Counter()
for m in matrix:
    for h in m["root_hints"]:
        hint_counter[h] += 1

# path pattern clustering
path_pat = Counter()
for m in matrix:
    path = urlparse(m["url"]).path
    # collapse numeric ids
    path2 = re.sub(r"/\d+", "/{n}", path)
    path2 = re.sub(r"[0-9a-f]{8,}", "{hex}", path2)
    path_pat[path2] += 1

report = {
    "leadId": "cmqp7cqya00011q5bkqf3ox8q",
    "company": "Sant'Arsenio Medical Centre",
    "frontierPath": FP,
    "crawlRun": {
        "state": run.get("state"),
        "sitemapStatus": run.get("sitemapStatus"),
        "stopReason": run.get("stopReason"),
        "totalDiscovered": run.get("totalDiscovered"),
        "totalRelevant": run.get("totalRelevant"),
        "totalCompleted": run.get("totalCompleted"),
        "totalPending": run.get("totalPending"),
        "totalFailed": run.get("totalFailed"),
        "urlCapReached": run.get("urlCapReached"),
        "timeCapReached": run.get("timeCapReached"),
    },
    "node_state_dist": dict(Counter(n["state"] for n in nodes)),
    "failed_matrix_count": len(matrix),
    "matrix": matrix,
    "error_counts": err_counter.most_common(),
    "host_counts": host_counter.most_common(),
    "discovery_source_counts": src_counter.most_common(),
    "relevance_counts": rel_counter.most_common(),
    "http_status_counts": status_counter.most_common(),
    "root_cause_hint_counts": hint_counter.most_common(),
    "path_patterns": path_pat.most_common(30),
    "eliminable_urls": [m["url"] for m in matrix if m["eliminable"]],
    "relevant_failed_not_eliminable": [m["url"] for m in matrix if m["necessary_for_HOT"] and not m["eliminable"]],
    "dominant_root_cause": (hint_counter.most_common(1)[0] if hint_counter else None),
}

OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print("matrix", len(matrix))
print("errors", err_counter.most_common(10))
print("hosts", host_counter.most_common())
print("src", src_counter.most_common())
print("rel", rel_counter.most_common())
print("status", status_counter.most_common())
print("hints", hint_counter.most_common())
print("paths", path_pat.most_common(15))
print("elim", len(report["eliminable_urls"]))
print("relevant_keep", len(report["relevant_failed_not_eliminable"]))
for m in matrix[:8]:
    print("-", m["relevance"], m["http_status"], m["url"][:100], "|", (m["error"] or "")[:80])
print("WROTE", OUT)
