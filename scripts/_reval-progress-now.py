#!/usr/bin/env python3
import json, os, sqlite3, subprocess
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
s = cp.get("stats") or {}
meta_p = Path("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json")
meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}

db = "/opt/leadsniper-revalidate/shadow-revalidate.db"
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
hc = con.execute("SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE'").fetchone()[0]
con.close()

log = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log")
tail = []
if log.is_file():
    data = log.read_bytes()
    text = data[-5000:].decode("utf-8", "replace")
    tail = [ln for ln in text.strip().splitlines() if ln.strip()][-10:]

svc = subprocess.getoutput("systemctl is-active giorgio-revalidate").strip()
proc = int(s.get("processed") or 0)
pct = round(100.0 * proc / hc, 1) if hc else None

print(json.dumps({
    "service": svc,
    "targetHcShadow": hc,
    "processed": proc,
    "pct": pct,
    "remainingApprox": max(0, hc - proc) if hc else None,
    "terminal": s.get("terminal"),
    "pub": s.get("pub"),
    "hot": s.get("hot"),
    "review": s.get("review"),
    "retry": s.get("retry"),
    "tech": s.get("tech"),
    "errors": s.get("errors"),
    "outOfScope": s.get("outOfScope"),
    "inProgress": len(cp.get("inProgress") or {}),
    "retryQueue": len(cp.get("retryQueue") or {}),
    "ENGINE_LOGICAL_SHA": (meta.get("ENGINE_LOGICAL_SHA") or "")[:12],
    "applyLiveExecuted": meta.get("applyLiveExecuted", 0),
    "logTail": tail,
}, indent=2))
