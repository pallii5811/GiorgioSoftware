#!/usr/bin/env python3
"""Inspect IATREION + Galdiero + San Paolo: current state and why HOT."""
import json, os, re
from pathlib import Path

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RES = Path("/opt/leadsniper-revalidate/data/revalidation/results")
ids = {
    "cmqma6d8e000q9g5crb0tkxag": "IATREION",
    "cmqmctogz008i9g5ctaoy1ii1": "Galdiero",
    "cmqn356yd000nzcq97g299ps1": "SanPaolo",
}
cp = json.load(open(CP))
term = cp.get("terminal") or {}
rq = cp.get("retryQueue") or {}
inp = cp.get("inProgress") or {}

for lid, name in ids.items():
    print("=" * 60, name, lid)
    if lid in term:
        print("TERMINAL", json.dumps(term[lid], indent=2)[:800])
    if lid in rq:
        print("RETRY", json.dumps(rq[lid], indent=2)[:800])
    if lid in inp:
        print("INPROG", json.dumps(inp[lid], indent=2)[:400])
    p = RES / f"{lid}.json"
    if not p.exists():
        print("NO RESULT FILE")
        continue
    r = json.load(open(p))
    keys = sorted(r.keys())
    print("result_keys", keys[:40])
    for k in (
        "companyName",
        "website",
        "outcome",
        "classification",
        "processingState",
        "newVerdict",
        "policyFound",
        "crawlComplete",
        "officialConfirmed",
        "policyCompany",
        "policyNumber",
        "policyExpiry",
        "reasonCode",
        "verdict",
        "businessVerdict",
    ):
        if k in r:
            print(f"  {k}={r[k]!r}"[:200])
    ev = r.get("fullEvidence") or ""
    print("fullEvidence_len", len(ev))
    print("fullEvidence_head", ev[:1200].replace("\n", " | "))
    # policy-ish snippets in evidence
    for pat in (
        r".{0,40}[Pp]olizza.{0,60}",
        r".{0,40}[Aa]ssicur.{0,60}",
        r".{0,30}amtrust.{0,40}",
        r".{0,30}Reale Mutua.{0,40}",
        r".{0,30}747217409.{0,30}",
        r".{0,30}2475660.{0,30}",
    ):
        ms = re.findall(pat, ev)
        if ms:
            print("EV_HITS", pat[:30], "->", ms[:3])
    # nested evidence
    for nest in ("evidence", "policy", "detector", "crawl", "frontier", "analysis"):
        if nest in r and isinstance(r[nest], (dict, list, str)):
            s = json.dumps(r[nest], ensure_ascii=False)[:500]
            print(f"nest.{nest}", s[:500])
