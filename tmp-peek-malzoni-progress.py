#!/usr/bin/env python3
import json, sqlite3, os
from pathlib import Path

FP = "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/frontiers/reval-p1-cmqklex5g00b6108ejom1shk0-1784845667638.sqlite"
CP = "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/checkpoint.json"
RES = "/opt/leadsniper-revalidate/data/stopship-retry11-rerun/results"

con = sqlite3.connect(FP)
print("by_state", con.execute("select state,count(*) from CrawlFrontierNode group by state").fetchall())
print(
    "cr_open",
    con.execute(
        "select state,count(*) from CrawlFrontierNode where relevance in ('critical','relevant') "
        "and state in ('DISCOVERED','QUEUED','FETCHING','RETRY_PENDING') group by state"
    ).fetchall(),
)
print(
    "cr_open_urls",
    con.execute(
        "select substr(canonicalUrl,1,120),state,relevance from CrawlFrontierNode "
        "where relevance in ('critical','relevant') and state in ('DISCOVERED','QUEUED','FETCHING','RETRY_PENDING') limit 10"
    ).fetchall(),
)
print(
    "pdf_by_state",
    con.execute(
        "select state,count(*) from CrawlFrontierNode where resourceType='pdf' or lower(canonicalUrl) like '%.pdf%' group by state"
    ).fetchall(),
)
con.close()

cp = json.load(open(CP, encoding="utf-8"))
r = cp.get("results", {}).get("cmqklex5g00b6108ejom1shk0", {})
print("malzoni_cp", {k: r.get(k) for k in ("attempts", "processingState", "lastReason", "lastError", "nextRetryAt", "forceDue", "strategy", "lastRunId")})
m = cp.get("results", {}).get("cmqmaf02a001k9g5crmkdun0w", {})
print("medicanova_cp", {k: m.get(k) for k in ("processingState", "newVerdict", "reasonCode", "finishedAt")})

# results dir
for lid in ("cmqklex5g00b6108ejom1shk0", "cmqmaf02a001k9g5crmkdun0w"):
    p = Path(RES) / f"{lid}.json"
    if p.exists():
        j = json.loads(p.read_text(encoding="utf-8"))
        print(
            "result",
            lid,
            {
                k: j.get(k)
                for k in (
                    "processingState",
                    "reasonCode",
                    "crawlComplete",
                    "businessVerdict",
                    "newVerdict",
                    "errorClass",
                    "finishedAt",
                )
            },
        )

# release
for p in (
    "/opt/leadsniper-revalidate/app/RELEASE_SHA",
    "/opt/leadsniper/RELEASE_SHA",
):
    if Path(p).exists():
        print(p, Path(p).read_text().strip())

# parent env
for pid_file in Path("/proc").iterdir():
    if not pid_file.name.isdigit():
        continue
    try:
        cmd = (pid_file / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="ignore")
    except Exception:
        continue
    if "production-revalidate-sanita-v3.mjs" in cmd and "flock" not in cmd:
        env = (pid_file / "environ").read_bytes().split(b"\0")
        for e in env:
            s = e.decode(errors="ignore")
            if s.startswith(("RELEASE", "TESTED_CODE_SHA", "APPLY_LIVE", "REVALIDATE_DUAL", "REVALIDATE_LEAD")):
                print("parent_env", s)
        print("parent_pid", pid_file.name)
        break
