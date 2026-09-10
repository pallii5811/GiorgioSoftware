#!/usr/bin/env python3
"""IDENTITY retry non deve più azzerare il frontier (loop infinito su 1 worker).
Con identità confermabile dal dominio first-party, 'fresh' butta solo il crawl fatto."""
import json
from datetime import datetime, timezone
from pathlib import Path

OLD = """  // Identity mismatch may need a clean seed surface — only allowed fresh case.
  if (/IDENTITY/i.test(err)) return "fresh";"""

NEW = """  // IDENTITY: il seed è lo stesso URL, quindi ripartire da zero butta via il crawl
  // già fatto e riaccoda lo stesso lead all'infinito. L'identità ora è confermabile
  // dal dominio first-party, quindi si riprende sempre il frontier esistente.
  if (/IDENTITY/i.test(err)) return n >= 2 ? "resume_boost" : "resume";"""

for p in [
    Path("/opt/leadsniper-revalidate/app/scripts/revalidate-checkpoint-v3.mjs"),
    Path("/opt/leadsniper/scripts/revalidate-checkpoint-v3.mjs"),
]:
    if not p.exists():
        continue
    raw = p.read_bytes()
    nl = "\r\n" if b"\r\n" in raw else "\n"
    s = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if 'if (/IDENTITY/i.test(err)) return n >= 2' in s:
        print("ALREADY", p)
        continue
    if OLD not in s:
        raise SystemExit(f"ANCHOR_FAIL {p}")
    p.write_bytes(s.replace(OLD, NEW, 1).replace("\n", nl).encode("utf-8"))
    print("PATCHED", p)

# Rewrite stored strategies so queued identity leads reuse their frontier
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(CP.read_text(encoding="utf-8"))
rq = cp.get("retryQueue") or {}
changed = 0
for lid, v in rq.items():
    blob = f"{v.get('lastReason')} {v.get('lastError')}".upper()
    if "IDENTITY" in blob and v.get("strategy") == "fresh":
        v["strategy"] = "resume"
        changed += 1
cp["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
CP.write_text(json.dumps(cp, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"identity_strategy_fresh_to_resume": changed, "retry_total": len(rq)}, indent=2))
