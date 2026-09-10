#!/usr/bin/env python3
"""READ-ONLY: reconcile terminal + retry + inProgress vs pool 877."""
import json
from pathlib import Path
cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
term = set((cp.get("terminal") or {}).keys())
rq = set((cp.get("retryQueue") or {}).keys())
inp = set((cp.get("inProgress") or {}).keys())
overlap_term_rq = term & rq
overlap_inp_rq = inp & rq
print(json.dumps({
    "source": "BACKEND checkpoint.json on Hetzner (NOT UI)",
    "terminal_now": len(term),
    "retryQueue_now": len(rq),
    "inProgress_now": len(inp),
    "sum_terminal_plus_retry_plus_running": len(term) + len(rq) + len(inp - term - rq),
    "unique_leads_touched": len(term | rq | inp),
    "overlap_terminal_and_retry": len(overlap_term_rq),
    "stats_processed_cumulative": (cp.get("stats") or {}).get("processed"),
    "stats_retry_cumulative": (cp.get("stats") or {}).get("retry"),
    "stats_terminal": (cp.get("stats") or {}).get("terminal"),
    "note": "retryQueue_now = lead ancora aperti da finire; stats.retry = contatore cumulativo tentativi, NON la coda",
}, indent=2))
