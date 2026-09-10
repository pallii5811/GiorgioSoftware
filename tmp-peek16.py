#!/usr/bin/env python3
import json
from collections import Counter
from pathlib import Path

T = Path("/opt/leadsniper-revalidate/data/stopship-retry11-rerun")
cp = json.loads((T / "checkpoint.json").read_text())
term = cp.get("terminal") or {}
retry = cp.get("retryQueue") or {}
ip = cp.get("inProgress") or {}
print("term", len(term), "retry", len(retry), "ip", list(ip))
print("term_states", Counter(v.get("processingState") for v in term.values()))
print("--- TERMINALS ---")
for lid, v in term.items():
    rp = T / "results" / f"{lid}.json"
    name = "?"
    row = {}
    if rp.exists():
        try:
            row = json.loads(rp.read_text())
            name = row.get("companyName")
        except Exception:
            pass
    print(
        lid,
        v.get("processingState"),
        v.get("reasonCode"),
        name,
        "crawlComplete=",
        row.get("crawlComplete"),
        "policy=",
        row.get("policyNumber"),
        row.get("policyExpiry"),
    )
print("--- RETRIES ---")
for lid, m in retry.items():
    rp = T / "results" / f"{lid}.json"
    row = {}
    if rp.exists():
        try:
            row = json.loads(rp.read_text())
        except Exception as e:
            row = {"err": str(e)}
    print(
        json.dumps(
            {
                "id": lid,
                "attempts": m.get("attempts"),
                "lastReason": m.get("lastReason"),
                "next": m.get("nextRetryAt"),
                "state": row.get("processingState"),
                "errClass": row.get("errorClass"),
                "stage": row.get("stage"),
                "url": row.get("failingUrl"),
                "name": row.get("companyName"),
                "error": (str(row.get("error") or "")[:300]),
                "stack": (str(row.get("stackSynth") or "")[:300]),
            },
            ensure_ascii=False,
        )
    )
print("--- IP ---")
for lid, m in ip.items():
    print(lid, m)
