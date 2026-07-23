#!/usr/bin/env python3
import json, re, subprocess
from pathlib import Path

i = "cmqmaor4t00389g5c2iuoauuw"
row = json.load(open(f"/opt/leadsniper-revalidate/data/revalidation/results/{i}.json"))
print(
    "FORMOSA",
    row.get("processingState"),
    "p1",
    (row.get("pass1") or {}).get("processingState"),
    "p2",
    (row.get("pass2") or {}).get("processingState"),
    "dual",
    row.get("dualDisagreement"),
    "policy",
    row.get("policyFound"),
    "crawl",
    row.get("crawlComplete"),
    "wall",
    row.get("wallMs"),
)
ev = row.get("fullEvidence") or ""
print("CRAWL", re.findall(r"\[CRAWL_COMPLETE:[^\]]+\]", ev)[:2])
print("FRONTIER", re.findall(r"\[FRONTIER:[^\]]+\]", ev)[:2])
print("STATE", re.findall(r"\[STATE:[^\]]+\]", ev)[:3])

j = "cmqp7cqya00011q5bkqf3ox8q"
row2 = json.load(open(f"/opt/leadsniper-revalidate/data/revalidation/results/{j}.json"))
print(
    "ARSENIO",
    row2.get("processingState"),
    row2.get("reasonCode"),
    row2.get("wallMs"),
    row2.get("error"),
    row2.get("finishedAt"),
)
ev2 = row2.get("fullEvidence") or ""
m = re.search(r"PUBLISHED gate: ([^\[]{0,200})", ev2)
print("ARSENIO gate", m.group(1).strip() if m else "none")
print("ARSENIO FRONTIER", re.findall(r"\[FRONTIER:[^\]]+\]", ev2)[:2])
print("ARSENIO STATE", re.findall(r"\[STATE:[^\]]+\]", ev2)[:3])
print("ARSENIO tail", ev2[-350:].replace("\n", " "))

cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("cp Formosa", cp.get("terminal", {}).get(i))
print("cp Arsenio term", cp.get("terminal", {}).get(j))
print("cp Arsenio retry", cp.get("retryQueue", {}).get(j))
print("RELEASE", open("/opt/leadsniper/RELEASE_SHA").read().strip())
