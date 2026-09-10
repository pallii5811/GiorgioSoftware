#!/usr/bin/env python3
"""BLOCKER 0 — audit the 2 ANALOGOUS terminals (no promotion)."""
import json, re, sqlite3
from pathlib import Path
from urllib.parse import urlparse

IDS = ["cmqktyimz000i111hygme29nh", "cmqklex5q00bh108eq9blm01k"]  # Malzoni, Pini
RD = Path("/opt/leadsniper-revalidate/data/revalidation/results")
CP = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
OUT = Path("/opt/leadsniper-revalidate/data/k3-stopship/ANALOGOUS_AUDIT.json")

COMMERCIAL = {
    "PUBLISHED_CURRENT",
    "PUBLISHED_EXPIRED",
    "PUBLISHED_DATE_UNKNOWN",
    "HOT_VERIFIED",
}


def host(u):
    try:
        return urlparse(u).hostname.replace("www.", "").lower() if u else None
    except Exception:
        return None


def same_reg(a, b):
    if not a or not b:
        return False
    return ".".join(a.split(".")[-2:]) == ".".join(b.split(".")[-2:])


def frontier_peek(fp):
    if not fp or not Path(fp).exists():
        return None
    try:
        con = sqlite3.connect(fp)
        con.row_factory = sqlite3.Row
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'").fetchall()]
        info = {"tables": tables, "path": fp, "size": Path(fp).stat().st_size}
        if "CrawlRun" in tables:
            run = con.execute("select * from CrawlRun order by rowid desc limit 1").fetchone()
            info["run"] = dict(run) if run else None
        if "DocumentEvidence" in tables:
            docs = con.execute(
                "select policyFound, contentHash, policyUrl, length(policyText) as ptlen from DocumentEvidence order by rowid desc limit 5"
            ).fetchall()
            info["docs"] = [dict(d) for d in docs]
            pf = con.execute("select count(*) from DocumentEvidence where policyFound=1").fetchone()[0]
            info["policyFoundCount"] = pf
        if "CrawlNode" in tables:
            info["nodesByState"] = con.execute(
                "select state, relevance, count(*) c from CrawlNode group by state, relevance"
            ).fetchall()
            info["nodesByState"] = [{"state": a, "relevance": b, "c": c} for a, b, c in info["nodesByState"]]
        con.close()
        return info
    except Exception as e:
        return {"error": str(e), "path": fp}


audits = []
for i in IDS:
    row = json.load(open(RD / f"{i}.json"))
    ev = row.get("fullEvidence") or ""
    t = CP.get("terminal", {}).get(i) or {}
    fps = [p for p in (row.get("frontierPaths") or []) if p]
    peeks = [frontier_peek(p) for p in fps]
    docs_urls = re.findall(r"https?://[^\s\]<>\"]+\.pdf", ev, re.I)
    state = t.get("processingState") or row.get("processingState")
    bv = row.get("businessVerdict")
    subtype = None
    if str(state).startswith("PUBLISHED_"):
        subtype = state
    site = row.get("website")
    evidence_url = docs_urls[0] if docs_urls else None
    # entity / first-party
    site_h = host(site)
    pol_h = host(evidence_url)
    first_party = same_reg(site_h, pol_h) if site_h and pol_h else False
    # hash from frontier docs if any
    doc_hash = None
    frontier_pf = False
    for pk in peeks:
        if not pk:
            continue
        for d in pk.get("docs") or []:
            if d.get("policyFound"):
                frontier_pf = True
                if d.get("contentHash"):
                    doc_hash = d["contentHash"]
                    break
    unresolved = None
    m = re.search(r"\[FRONTIER:(?:OPEN|CLOSED|EXHAUSTED),p=(\d+),f=(\d+)", ev)
    if m:
        unresolved = int(m[1]) + int(m[2])
    crawl_complete = bool(re.search(r"\[CRAWL_COMPLETE:true\]", ev, re.I))
    # GATE: ANALOGOUS alone is NOT commercial
    countable = False
    reason = (
        f"processingState={state} is NOT in commercial set "
        f"{sorted(COMMERCIAL)}; ANALOGOUS alone must not count"
    )
    if state in COMMERCIAL:
        countable = True
        reason = "canonical commercial state"
    item = {
        "leadId": i,
        "company": row.get("companyName"),
        "canonical_processingState": state,
        "canonical_businessVerdict": bv,
        "commercial_subtype": subtype,
        "evidence_URL": evidence_url,
        "website": site,
        "sourceClass": "FIRST_PARTY_FACILITY" if first_party else "UNKNOWN_OR_NOT_FIRST_PARTY",
        "entity_attribution": {
            "policyFound": row.get("policyFound"),
            "firstPartyUrl": first_party,
            "siteHost": site_h,
            "policyHost": pol_h,
            "IDENTITY": re.findall(r"\[IDENTITY:[^\]]+\]", ev)[:2],
        },
        "document_hash": doc_hash,
        "frontier_complete": crawl_complete and unresolved == 0,
        "unresolvedRelevantNodes": unresolved,
        "frontier_policyFound": frontier_pf,
        "frontier_peeks": peeks,
        "wallMs": row.get("wallMs"),
        "countable_as_commercial": countable,
        "reason_counted_or_not": reason,
        "evidence_head": ev[:350].replace("\n", " "),
    }
    audits.append(item)
    print(json.dumps({k: item[k] for k in item if k not in ("frontier_peeks", "evidence_head")}, ensure_ascii=False, indent=1))
    print("---")

# Full sample recalculation
sample = "cmqkld5rk009b108ekvol7g87,cmql4qrif000yc9w74e0tmpqt,cmql4d399000uc9w7yzw2dgac,cmqktyimz000i111hygme29nh,cmqklex5q00bh108eq9blm01k,cmql4d38u000kc9w7ng9zvakw,cmqkld5rt009m108ejllpw8nz,cmqmaor4t00389g5c2iuoauuw,cmqp7cqya00011q5bkqf3ox8q,cmqoe7vww004aaa3v67rkgl4e".split(",")
rows_meta = {}
for i in sample:
    t = CP.get("terminal", {}).get(i)
    r = CP.get("retryQueue", {}).get(i)
    st = (t or {}).get("processingState") or (r or {}).get("lastReason")
    website = None
    p = RD / f"{i}.json"
    if p.exists():
        try:
            website = json.load(open(p)).get("website")
        except Exception:
            pass
    rows_meta[i] = {"state": st, "terminal": bool(t), "website": website}

commercial = [i for i, m in rows_meta.items() if m["state"] in COMMERCIAL]
# reachable = has website
reachable = [i for i, m in rows_meta.items() if m.get("website")]
reachable_commercial = [i for i in commercial if i in reachable]
summary = {
    "audits": audits,
    "analogous_countable": sum(1 for a in audits if a["countable_as_commercial"]),
    "commercial_ids": commercial,
    "commercial_count": len(commercial),
    "rawCompletionRate": len(commercial) / 10,
    "reachable_ids": reachable,
    "reachable_count": len(reachable),
    "reachable_commercial": len(reachable_commercial),
    "reachableCompletionRate": (len(reachable_commercial) / len(reachable)) if reachable else 0,
    "byState": {},
}
for m in rows_meta.values():
    summary["byState"][m["state"]] = summary["byState"].get(m["state"], 0) + 1
OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print("WROTE", OUT)
print("commercial", len(commercial), "raw", summary["rawCompletionRate"])
print("reachable", len(reachable), "reach_comm", len(reachable_commercial), "rate", summary["reachableCompletionRate"])
print("byState", summary["byState"])
