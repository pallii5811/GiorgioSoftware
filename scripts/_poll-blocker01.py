#!/usr/bin/env python3
"""Poll blocker01 retry progress."""
import json
import time
from pathlib import Path

IDS = [
    "cmqp7cqya00011q5bkqf3ox8q",
    "cmqktyimz000i111hygme29nh",
    "cmqklex5q00bh108eq9blm01k",
]
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
RD = Path("/opt/leadsniper-revalidate/data/revalidation/results")
LOG = Path("/tmp/k3-blocker01-retry.log")

cp = json.loads(CP.read_text())
print("log_tail:")
if LOG.exists():
    lines = LOG.read_text(errors="replace").splitlines()
    for L in lines[-15:]:
        print(L)
print("---")
for i in IDS:
    t = cp.get("terminal", {}).get(i)
    r = cp.get("retryQueue", {}).get(i)
    ip = cp.get("inProgress", {}).get(i)
    st = None
    if (RD / f"{i}.json").exists():
        try:
            row = json.loads((RD / f"{i}.json").read_text())
            st = row.get("processingState")
            print(
                i,
                "result",
                st,
                "bv",
                row.get("businessVerdict"),
                "reason",
                row.get("reasonCode"),
                "wall",
                row.get("wallMs"),
            )
        except Exception as e:
            print(i, "result_err", e)
    print(
        " ",
        "term",
        (t or {}).get("processingState") if t else None,
        "retry",
        (r or {}).get("lastReason") if r else None,
        "inProg",
        bool(ip),
    )
