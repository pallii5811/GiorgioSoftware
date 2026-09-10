#!/usr/bin/env python3
"""Riscrive le strategie 'fresh' in coda (identity + tutte) -> resume, e verifica il patch motore."""
import json
from datetime import datetime, timezone
from pathlib import Path

ENGINE = Path("/opt/leadsniper-revalidate/app/scripts/revalidate-checkpoint-v3.mjs")
src = ENGINE.read_text(encoding="utf-8")
assert 'if (/IDENTITY/i.test(err)) return n >= 2' in src, "ENGINE_NOT_PATCHED"
assert 'return "fresh"' not in src.split("export function pickRetryStrategy")[1].split("}")[0], "STILL_FRESH"
print("ENGINE_PATCH_OK")

CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
cp = json.loads(CP.read_text(encoding="utf-8"))
rq = cp.get("retryQueue") or {}

changed_identity = 0
changed_other = 0
for lid, v in rq.items():
    if v.get("strategy") != "fresh":
        continue
    blob = f"{v.get('lastReason')} {v.get('lastError')}".upper()
    v["strategy"] = "resume"
    if "IDENTITY" in blob:
        changed_identity += 1
    else:
        changed_other += 1

cp["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
CP.write_text(json.dumps(cp, indent=2, ensure_ascii=False), encoding="utf-8")

from collections import Counter
print(json.dumps({
    "fresh_to_resume_identity": changed_identity,
    "fresh_to_resume_other": changed_other,
    "retry_total": len(rq),
    "strategies_now": dict(Counter(str(v.get("strategy")) for v in rq.values()).most_common()),
}, indent=2))
