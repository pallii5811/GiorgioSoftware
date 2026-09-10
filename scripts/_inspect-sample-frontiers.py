#!/usr/bin/env python3
import json, sqlite3
from pathlib import Path

s = json.load(open("/opt/leadsniper-revalidate/data/k3-stopship/RETRY20_SAMPLE.json"))
cp = json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
for r in s["records"]:
    lid = r["leadId"]
    meta = (cp.get("retryQueue") or {}).get(lid) or {}
    fp = meta.get("frontierPath") or r.get("frontierPath")
    err = (meta.get("lastError") or r.get("initialError") or "")
    if not fp or not Path(fp).exists():
        continue
    if not any(x in str(err) for x in ("FRONTIER", "PDF", "SITEMAP", "ANALYZE", "RETRY", "CRAWL")):
        continue
    con = sqlite3.connect(fp)
    tables = [t[0] for t in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    print("====", lid, err[:40], Path(fp).name)
    print("tables", tables)
    if "CrawlFrontierNode" in tables:
        rows = con.execute("SELECT state, COUNT(*) FROM CrawlFrontierNode GROUP BY state").fetchall()
        print("states", rows)
        cols = [c[1] for c in con.execute("PRAGMA table_info(CrawlFrontierNode)").fetchall()]
        print("cols", cols)
        fails = con.execute(
            "SELECT state, substr(canonicalUrl,1,80), relevance, retryCount FROM CrawlFrontierNode WHERE state='FAILED' LIMIT 6"
        ).fetchall()
        print("fails", fails)
        pdfs = con.execute(
            "SELECT state, COUNT(*) FROM CrawlFrontierNode WHERE lower(canonicalUrl) LIKE '%.pdf%' OR contentType LIKE '%pdf%' GROUP BY state"
        ).fetchall() if "contentType" in cols else con.execute(
            "SELECT state, COUNT(*) FROM CrawlFrontierNode WHERE lower(canonicalUrl) LIKE '%.pdf%' GROUP BY state"
        ).fetchall()
        print("pdf_states", pdfs)
    if "CrawlRun" in tables:
        cols = [c[1] for c in con.execute("PRAGMA table_info(CrawlRun)").fetchall()]
        print("run_cols", cols)
        print("run", con.execute("SELECT * FROM CrawlRun LIMIT 1").fetchone())
    con.close()
