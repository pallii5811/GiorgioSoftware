#!/usr/bin/env python3
"""Post-stopship gates: CRM, apply, hashes, progress."""
import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path

APP = Path("/opt/leadsniper-revalidate/app")
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
META = Path("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json")
LIVE_DB = Path("/opt/leadsniper/prisma/dev.db")
# find live db
candidates = [
    Path("/opt/leadsniper/prisma/dev.db"),
    Path("/opt/leadsniper/data/prod.db"),
    Path("/opt/leadsniper/giorgio-live.db"),
]
for c in list(Path("/opt/leadsniper").rglob("*.db"))[:30]:
    if "backup" in str(c).lower() or "shadow" in str(c).lower():
        continue
    candidates.append(c)

unit = Path("/etc/systemd/system/giorgio-revalidate.service").read_text()
cp = json.loads(CP.read_text())
s = cp.get("stats") or {}
meta = json.loads(META.read_text()) if META.exists() else {}

# worker behavior greps
worker = (APP / "scripts/production-revalidate-sanita-worker.mjs").read_text()
checks = {
    "imports_acceptCanonical": "acceptCanonicalPublishedTerminal" in worker,
    "no_scadut_promo": "scadut" not in worker.lower() or "scadut" not in worker,  # crude
    "has_scadut_literal": "scadut" in worker,
    "has_PUBLISHED_EXPIRED_regex_promo": bool(
        __import__("re").search(r"PUBLISHED_EXPIRED.*\[DOCS\]|scadut.*PUBLISHED", worker, __import__("re").I)
    ),
    "non_canonical_pub_to_retry": 'startsWith("PUBLISHED")' in worker and "RETRY_PENDING" in worker,
    "identity_review": "REVIEW_HUMAN" in worker or "identity" in worker.lower(),
}

# CRM on live: count NEW / non-NEW for healthcare if db found
crm = {"foundDb": None, "healthcare": None, "crmNew": None, "crmOther": None, "loss": None}
for db in candidates:
    if not db.exists() or db.stat().st_size < 1000:
        continue
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        cur = con.cursor()
        # prisma Lead table?
        tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if "Lead" not in tables and "leads" not in tables:
            con.close()
            continue
        t = "Lead" if "Lead" in tables else "leads"
        cols = [r[1] for r in cur.execute(f"PRAGMA table_info({t})").fetchall()]
        type_col = "type" if "type" in cols else None
        crm_col = "crmStatus" if "crmStatus" in cols else ("crm_status" if "crm_status" in cols else None)
        if not type_col:
            con.close()
            continue
        hc = cur.execute(f"SELECT COUNT(*) FROM {t} WHERE {type_col}='HEALTHCARE'").fetchone()[0]
        if crm_col:
            new_n = cur.execute(
                f"SELECT COUNT(*) FROM {t} WHERE {type_col}='HEALTHCARE' AND {crm_col}='NEW'"
            ).fetchone()[0]
            other = cur.execute(
                f"SELECT COUNT(*) FROM {t} WHERE {type_col}='HEALTHCARE' AND ({crm_col} IS NULL OR {crm_col}!='NEW')"
            ).fetchone()[0]
        else:
            new_n, other = None, None
        con.close()
        crm = {
            "foundDb": str(db),
            "healthcare": hc,
            "crmNew": new_n,
            "crmOther": other,
            "loss": 0 if (other == 0 or other is None) else other,
        }
        break
    except Exception as e:
        crm = {"error": str(e), "tried": str(db)}

# apply processes
ps = subprocess.getoutput("ps aux | grep -E 'production-apply|apply-revalidation|apply-certified' | grep -v grep || true")

out = {
    "service": subprocess.getoutput("systemctl is-active giorgio-revalidate").strip(),
    "DISABLE_LIVE_DB": "DISABLE_LIVE_DB=true" in unit,
    "DATABASE_URL_shadow": "shadow-revalidate.db" in unit,
    "ENGINE_LOGICAL_SHA": meta.get("ENGINE_LOGICAL_SHA"),
    "RELEASE_SHA_file": (APP / "RELEASE_SHA").read_text().strip() if (APP / "RELEASE_SHA").exists() else None,
    "workerSha": hashlib.sha256((APP / "scripts/production-revalidate-sanita-worker.mjs").read_bytes()).hexdigest(),
    "workerBytes": (APP / "scripts/production-revalidate-sanita-worker.mjs").stat().st_size,
    "checks": checks,
    "processed": s.get("processed"),
    "stats": s,
    "terminal": len(cp.get("terminal") or {}),
    "inProgress": len(cp.get("inProgress") or {}),
    "retryQueue": len(cp.get("retryQueue") or {}),
    "checkpointSha": hashlib.sha256(CP.read_bytes()).hexdigest(),
    "applyLiveExecuted": meta.get("applyLiveExecuted", 0),
    "applyProcesses": ps.strip() or "none",
    "crm": crm,
    "tests": meta.get("tests"),
}
print(json.dumps(out, indent=2))
