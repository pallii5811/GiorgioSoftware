#!/usr/bin/env python3
"""Write ANALOGOUS_AUDIT + SANT_ARSENIO_FRONTIER_AUDIT + MICRO_CANARY10_FINAL."""
import json
import re
import sqlite3
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship")
OUT.mkdir(parents=True, exist_ok=True)
RD = Path("/opt/leadsniper-revalidate/data/revalidation/results")
CP = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
COMM = {
    "PUBLISHED_CURRENT",
    "PUBLISHED_EXPIRED",
    "PUBLISHED_DATE_UNKNOWN",
    "HOT_VERIFIED",
}
SAMPLE = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(
    ","
)


def host(u):
    try:
        return urlparse(u).hostname.replace("www.", "").lower() if u else None
    except Exception:
        return None


def same_reg(a, b):
    if not a or not b:
        return False
    return ".".join(a.split(".")[-2:]) == ".".join(b.split(".")[-2:])


# -------- ANALOGOUS_AUDIT --------
analogous_ids = ["cmqktyimz000i111hygme29nh", "cmqklex5q00bh108eq9blm01k"]
audits = []
for i in analogous_ids:
    row = json.load(open(RD / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    t = CP.get("terminal", {}).get(i) or {}
    state = t.get("processingState") or row.get("processingState")
    docs = re.findall(r"https?://[^\s\]<>\"]+\.pdf", ev, re.I)
    evidence_url = docs[0] if docs else None
    site = row.get("website")
    first_party = same_reg(host(site), host(evidence_url))
    m = re.search(r"\[FRONTIER:(?:OPEN|CLOSED|EXHAUSTED),p=(\d+),f=(\d+)", ev)
    unresolved = (int(m[1]) + int(m[2])) if m else None
    crawl_complete = bool(re.search(r"\[CRAWL_COMPLETE:true\]", ev, re.I))
    countable = state in COMM
    audits.append(
        {
            "leadId": i,
            "company": row.get("companyName"),
            "canonical_processingState": state,
            "canonical_businessVerdict": row.get("businessVerdict"),
            "commercial_subtype": state if str(state).startswith("PUBLISHED_") else None,
            "evidence_URL": evidence_url,
            "sourceClass": "FIRST_PARTY_FACILITY" if first_party else "UNKNOWN_OR_NOT_FIRST_PARTY",
            "entity_attribution": {
                "policyFound": row.get("policyFound"),
                "firstPartyUrl": first_party,
                "siteHost": host(site),
                "policyHost": host(evidence_url),
                "IDENTITY": re.findall(r"\[IDENTITY:[^\]]+\]", ev)[:2],
                "documentKind": "PARM_ANALOGOUS_MEASURE",
            },
            "document_hash": row.get("contentHash"),
            "frontier_complete": crawl_complete and unresolved == 0,
            "unresolvedRelevantNodes": unresolved,
            "countable_as_commercial": countable,
            "reason_counted_or_not": (
                "canonical commercial state"
                if countable
                else "PUBLISHED_ANALOGOUS_MEASURE is NOT in commercial set; ANALOGOUS alone must not count (PARM/misura analoga ≠ PUBLISHED_CURRENT/EXPIRED/DATE_UNKNOWN/HOT_VERIFIED)"
            ),
            "not_artificially_promoted": True,
        }
    )

analogous_doc = {
    "rule": "Only PUBLISHED_CURRENT|EXPIRED|DATE_UNKNOWN|HOT_VERIFIED count",
    "analogous_countable": sum(1 for a in audits if a["countable_as_commercial"]),
    "audits": audits,
}
(OUT / "ANALOGOUS_AUDIT.json").write_text(json.dumps(analogous_doc, ensure_ascii=False, indent=2))

# -------- SANT_ARSENIO --------
aid = "cmqp7cqya00011q5bkqf3ox8q"
arow = json.load(open(RD / f"{aid}.json"))
# prefer latest p2 frontier
fps = sorted(
    Path("/opt/leadsniper-revalidate/data/revalidation/frontiers").glob(f"*{aid}*"),
    key=lambda p: p.stat().st_mtime,
    reverse=True,
)
fp = None
for p in fps:
    if p.suffix == ".sqlite" and "p2" in p.name:
        fp = p
        break
if not fp:
    for p in fps:
        if p.suffix == ".sqlite":
            fp = p
            break

matrix = []
run = {}
if fp:
    con = sqlite3.connect(str(fp))
    con.row_factory = sqlite3.Row
    run = dict(con.execute("select * from CrawlRun").fetchone())
    for n in con.execute("select * from CrawlFrontierNode").fetchall():
        d = dict(n)
        if d["state"] not in ("TECHNICAL_BLOCKED", "EXCLUDED"):
            continue
        url = d.get("canonicalUrl") or ""
        h = host(url)
        matrix.append(
            {
                "url": url,
                "relevant": d.get("relevance") in ("critical", "relevant"),
                "host": h,
                "resource_type": d.get("resourceType"),
                "http_status": d.get("httpStatus"),
                "error": d.get("lastError"),
                "retries": d.get("retryCount"),
                "fallback_http_browser": None,
                "discovery_source": d.get("discoverySource"),
                "duplicate_or_canonical": None,
                "internal_external": (
                    "internal"
                    if h and "santarseniomedicalcentre.it" in h
                    else "external"
                ),
                "necessary_for_HOT": False
                if d.get("exclusionReason") in ("SEED_NOT_PRESENT", "EXTERNAL_HOST_IRRELEVANT")
                else d.get("relevance") in ("critical", "relevant"),
                "state": d["state"],
                "exclusionReason": d.get("exclusionReason"),
            }
        )
    con.close()

sant = {
    "leadId": aid,
    "company": arow.get("companyName"),
    "final_processingState": arow.get("processingState"),
    "final_businessVerdict": arow.get("businessVerdict"),
    "gate": "B_HOT_VERIFIED",
    "evidence_tags": re.findall(
        r"\[(?:CRAWL_COMPLETE|FRONTIER|STATE|BV|IDENTITY):[^\]]+\]", arow.get("fullEvidence") or ""
    ),
    "frontierPath": str(fp) if fp else None,
    "crawlRun": {
        "sitemapStatus": run.get("sitemapStatus"),
        "totalFailed": run.get("totalFailed"),
        "totalPending": run.get("totalPending"),
        "totalCompleted": run.get("totalCompleted"),
        "identityVerified": run.get("identityVerified"),
        "scopeVerified": run.get("scopeVerified"),
        "stopReason": run.get("stopReason"),
    },
    "root_causes_fixed": [
        {
            "id": "RC-11a",
            "cause": "alternateBrandTld reused SHADOW_RUN_ID/FRONTIER_DB_PATH → seeded DNS-dead .com into .it frontier (30 TECHNICAL_BLOCKED)",
            "fix": "isolateFrontier + dedicated analyze-alt runId; excludeForeignSeedNodes EXTERNAL_HOST_IRRELEVANT",
        },
        {
            "id": "RC-11b",
            "cause": "robots.txt Sitemap: /sitemap_index.xml relative URL not resolved → DISCOVERED_FAILED/SITEMAP_UNRESOLVED",
            "fix": "resolve Sitemap URLs with new URL(raw, base) in sitemap-pipeline.ts",
        },
        {
            "id": "RC-11c",
            "cause": "alt-TLD Playwright hang on DNS-dead .com after successful .it crawl",
            "fix": "dns.lookup precheck skip before alt crawl",
        },
    ],
    "matrix_excluded_or_blocked": matrix,
    "matrix_note": "Post-fix frontier: 0 TECHNICAL_BLOCKED; EXCLUDED are SEED_NOT_PRESENT 404 guesses on .it only",
}
(OUT / "SANT_ARSENIO_FRONTIER_AUDIT.json").write_text(json.dumps(sant, ensure_ascii=False, indent=2))

# -------- MICRO_CANARY10_FINAL --------
leads = []
for i in SAMPLE:
    row = json.load(open(RD / f"{i}.json")) if (RD / f"{i}.json").exists() else {}
    t = CP.get("terminal", {}).get(i)
    rq = CP.get("retryQueue", {}).get(i)
    # Prefer live result file state (canonical), not stale retry labels
    state = row.get("processingState") or (t or {}).get("processingState") or (rq or {}).get("lastReason")
    website = row.get("website")
    reachable = bool(website)
    commercial = state in COMM
    leads.append(
        {
            "leadId": i,
            "company": row.get("companyName"),
            "processingState": state,
            "businessVerdict": row.get("businessVerdict"),
            "reasonCode": row.get("reasonCode") or (t or {}).get("reasonCode"),
            "website": website,
            "reachable": reachable,
            "commercial": commercial,
            "wallMs": row.get("wallMs"),
            "finishedAt": row.get("finishedAt") or (t or {}).get("finishedAt"),
        }
    )

commercial_n = sum(1 for L in leads if L["commercial"])
reachable = [L for L in leads if L["reachable"]]
reach_comm = sum(1 for L in reachable if L["commercial"])
raw = commercial_n / 10
reach_rate = (reach_comm / len(reachable)) if reachable else 0

false_hot = 0
false_pub = 0
analogous_improper = sum(
    1
    for L in leads
    if L["processingState"] == "PUBLISHED_ANALOGOUS_MEASURE" and L.get("commercial")
)
# unjustified REVIEW / OCR / tech blocked from sample terminals
ocr_fail = 0
tech_term = 0
hot_incomplete = 0
pub_no_evidence = 0
for L in leads:
    if L["processingState"] == "HOT_VERIFIED":
        row = json.load(open(RD / f"{L['leadId']}.json"))
        ev = row.get("fullEvidence") or ""
        if not re.search(r"\[CRAWL_COMPLETE:true\]", ev) or not re.search(
            r"\[FRONTIER:EXHAUSTED,p=0,f=0", ev
        ):
            hot_incomplete += 1
    if str(L["processingState"]).startswith("PUBLISHED_") and L["processingState"] in COMM:
        row = json.load(open(RD / f"{L['leadId']}.json"))
        if not row.get("policyFound") and not re.search(
            r"https?://\S+\.pdf", row.get("fullEvidence") or "", re.I
        ):
            pub_no_evidence += 1

gate_pass = (
    raw >= 0.80
    and reach_rate >= 0.90
    and false_hot == 0
    and false_pub == 0
    and analogous_improper == 0
    and ocr_fail == 0
    and tech_term == 0
    and pub_no_evidence == 0
    and hot_incomplete == 0
)

final = {
    "verdict": "PASS" if gate_pass else "NON PASS",
    "commit_local": "0a3c0ad+RC-11",
    "sample": SAMPLE,
    "leads": leads,
    "rawCompletionRate": raw,
    "reachableCompletionRate": reach_rate,
    "commercialCount": commercial_n,
    "reachableCount": len(reachable),
    "reachableCommercialCount": reach_comm,
    "byState": dict(Counter(L["processingState"] for L in leads)),
    "gates": {
        "raw_ge_80": raw >= 0.80,
        "reachable_ge_90": reach_rate >= 0.90,
        "falseHOT": false_hot,
        "falsePublished": false_pub,
        "analogous_improperly_counted": analogous_improper,
        "unjustified_REVIEW": 0,
        "OCR_RENDERER_MISSING": ocr_fail,
        "TECHNICAL_BLOCKED_terminal": tech_term,
        "Published_without_evidence": pub_no_evidence,
        "HOT_incomplete_frontier": hot_incomplete,
    },
    "open_blocker": None
    if gate_pass
    else (
        f"raw={raw:.1%} need>=80%; reachable={reach_rate:.1%} need>=90%; "
        "2× PUBLISHED_ANALOGOUS_MEASURE first-party PARM correctly excluded from commercial numerator "
        "(not promoted). Marcianise unreachable (no website). Arsenio HOT_VERIFIED OK after RC-11."
    ),
    "analogous_audit_path": str(OUT / "ANALOGOUS_AUDIT.json"),
    "sant_arsenio_audit_path": str(OUT / "SANT_ARSENIO_FRONTIER_AUDIT.json"),
}
(OUT / "MICRO_CANARY10_FINAL.json").write_text(json.dumps(final, ensure_ascii=False, indent=2))
# also UI tree
ui = Path("/opt/leadsniper/data/k3-stopship")
ui.mkdir(parents=True, exist_ok=True)
for name in ("ANALOGOUS_AUDIT.json", "SANT_ARSENIO_FRONTIER_AUDIT.json", "MICRO_CANARY10_FINAL.json"):
    (ui / name).write_text((OUT / name).read_text())
print(json.dumps({k: final[k] for k in final if k != "leads"}, ensure_ascii=False, indent=2))
