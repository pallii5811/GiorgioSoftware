#!/usr/bin/env python3
"""Freeze 20 real retry IDs covering all error classes; force due; write gate sample."""
import json, os, time
from collections import defaultdict
from datetime import datetime, timezone

CP = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/revalidation/results"
OUT = "/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json"

cp = json.load(open(CP))
rq = cp.get("retryQueue") or {}
by_err = defaultdict(list)
for lid, meta in rq.items():
    err = (meta or {}).get("lastError") or (meta or {}).get("lastReason") or "RETRY_PENDING"
    # normalize
    for key in (
        "CRAWL_CAP",
        "FRONTIER_INCOMPLETE",
        "SITEMAP_UNRESOLVED",
        "PDF_UNPROCESSED",
        "LEAD_WALL_TIMEOUT",
        "WORKER_SIGTERM",
        "RETRY_PENDING",
    ):
        if key in str(err).upper() or (key == "LEAD_WALL_TIMEOUT" and "LEAD_WALL" in str(err).upper()):
            by_err[key].append(lid)
            break
    else:
        by_err["OTHER"].append(lid)

wanted = [
    "CRAWL_CAP",
    "FRONTIER_INCOMPLETE",
    "SITEMAP_UNRESOLVED",
    "PDF_UNPROCESSED",
    "LEAD_WALL_TIMEOUT",
    "WORKER_SIGTERM",
]
sample = []
# at least one of each if present
for k in wanted:
    for lid in by_err.get(k, [])[:3]:
        if lid not in sample:
            sample.append(lid)

# fill from recent RETRY_PENDING result files not already sampled
if len(sample) < 20:
    files = []
    for name in os.listdir(RES):
        if name.endswith(".json") and not name.endswith(".p1.json") and not name.endswith(".p2.json"):
            p = os.path.join(RES, name)
            files.append((os.path.getmtime(p), name.replace(".json", "")))
    files.sort(reverse=True)
    term = set((cp.get("terminal") or {}).keys())
    for _, lid in files:
        if lid in term or lid in sample:
            continue
        row = json.load(open(os.path.join(RES, f"{lid}.json")))
        if row.get("processingState") != "RETRY_PENDING":
            continue
        sample.append(lid)
        if len(sample) >= 20:
            break

# still short: take any remaining retry queue
for lid in rq:
    if lid not in sample:
        sample.append(lid)
    if len(sample) >= 20:
        break

sample = sample[:20]
records = []
for lid in sample:
    meta = rq.get(lid) or {}
    row = None
    p = os.path.join(RES, f"{lid}.json")
    if os.path.isfile(p):
        row = json.load(open(p))
    fp = meta.get("frontierPath") or (row or {}).get("pass1", {}).get("frontierPath")
    records.append(
        {
            "leadId": lid,
            "companyName": (row or {}).get("companyName"),
            "initialError": meta.get("lastError") or meta.get("lastReason") or (row or {}).get("reasonCode"),
            "attempts": meta.get("attempts") or 0,
            "frontierPath": fp,
            "lastRunId": meta.get("lastRunId"),
            "initialCompletedNodes": None,
        }
    )
    # frontier node counts if sqlite available
    if fp and os.path.isfile(fp):
        try:
            import sqlite3

            con = sqlite3.connect(fp)
            cur = con.execute(
                "SELECT state, COUNT(*) FROM nodes GROUP BY state"
                if False
                else "SELECT name FROM sqlite_master WHERE type='table'"
            )
            tables = [r[0] for r in cur.fetchall()]
            # frontier-store schema uses frontier_nodes or nodes
            tname = "frontier_nodes" if "frontier_nodes" in tables else ("nodes" if "nodes" in tables else None)
            if tname:
                rows = con.execute(f"SELECT state, COUNT(*) FROM {tname} GROUP BY state").fetchall()
                records[-1]["initialCompletedNodes"] = {s: c for s, c in rows}
            con.close()
        except Exception as e:
            records[-1]["frontierError"] = str(e)

# force all sample due immediately + ensure in retryQueue
now0 = datetime(1970, 1, 1, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
for lid in sample:
    if lid not in rq:
        row = json.load(open(os.path.join(RES, f"{lid}.json"))) if os.path.isfile(os.path.join(RES, f"{lid}.json")) else {}
        rq[lid] = {
            "attempts": 1,
            "lastReason": row.get("reasonCode") or "RETRY_PENDING",
            "lastError": row.get("reasonCode") or "RETRY_PENDING",
            "nextRetryAt": now0,
            "lastRunId": (row.get("pass1") or {}).get("runId") or (row.get("runIds") or [None])[0],
            "frontierPath": (row.get("pass1") or {}).get("frontierPath") or (row.get("frontierPaths") or [None])[0],
            "firstSeenAt": row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
            "lastAttemptAt": row.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
            "operational": True,
        }
    else:
        rq[lid]["nextRetryAt"] = now0
    # clear from inProgress if stuck
    (cp.get("inProgress") or {}).pop(lid, None)

cp["retryQueue"] = rq
cp["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
# atomic write
tmp = CP + ".tmp"
json.dump(cp, open(tmp, "w"), ensure_ascii=False, indent=2)
os.replace(tmp, CP)

payload = {
    "frozenAt": datetime.now(timezone.utc).isoformat(),
    "terminalBefore": len(cp.get("terminal") or {}),
    "retryBefore": len(rq),
    "sampleSize": len(sample),
    "byErrorAvailable": {k: len(v) for k, v in by_err.items()},
    "records": records,
}
json.dump(payload, open(OUT, "w"), ensure_ascii=False, indent=2)
print(json.dumps({"out": OUT, "n": len(sample), "ids": sample, "byError": payload["byErrorAvailable"]}, indent=2))
