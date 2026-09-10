#!/usr/bin/env python3
"""Complete Esito B: meta + resume + gate checks (no checkpoint wipe)."""
import hashlib
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

CERT = "fe8b677a2cb4372d6f117c8534d473a51d40913b"
APP = Path("/opt/leadsniper-revalidate/app")
DATA = Path("/opt/leadsniper-revalidate/data/revalidation")
META = DATA / "archive-run-meta.json"
CP = DATA / "checkpoint.json"
BASELINE_DIR = Path("/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z")
EXPECTED_BASELINE_JSON = "5e93be5d8dd71384f9773138b5b1392c40f5550535266f39671e11af60d22894"

FILES = [
    "scripts/production-revalidate-sanita-v3.mjs",
    "scripts/production-revalidate-sanita-worker.mjs",
    "scripts/revalidate-checkpoint-v3.mjs",
    "src/lib/sanita/canonical-published-terminal.ts",
    "src/lib/sanita/crawl-slice-runner.ts",
    "src/lib/sanita/scan-engine.ts",
]

hashes = {}
for rel in FILES:
    p = APP / rel
    b = p.read_bytes()
    hashes[rel] = {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)}

cp_before = json.loads(CP.read_text())
cp_sha_before = hashlib.sha256(CP.read_bytes()).hexdigest()

meta = json.loads(META.read_text()) if META.exists() else {}
meta["ENGINE_LOGICAL_SHA"] = CERT
meta["engineFileHashes"] = hashes
meta["stopshipEsito"] = "B"
meta["stopshipCompletedAt"] = datetime.now(timezone.utc).isoformat()
meta["applyLiveEnabled"] = False
meta["applyLiveExecuted"] = 0
meta["uncertifiedResultsRequireRevalidation"] = True
meta["preCertProcessed"] = (cp_before.get("stats") or {}).get("processed")
meta["checkpointShaBeforeResume"] = cp_sha_before
meta["tests"] = {
    "test-published-worker-canonical": "PASS",
    "test-revalidation-v3": "PASS",
    "runner": "npx tsx (service tree; plain node fails on @/ alias)",
}
META.write_text(json.dumps(meta, indent=2) + "\n")
print("meta_ok", META)

# baseline gate
bj = BASELINE_DIR / "published-legacy-baseline.json"
assert bj.exists(), "baseline json missing"
bj_raw = bj.read_bytes()
bj_sha = hashlib.sha256(bj_raw).hexdigest()
baseline_obj = json.loads(bj_raw)
baseline_count = int(baseline_obj.get("count") or len(baseline_obj.get("records") or []))
assert bj_sha == EXPECTED_BASELINE_JSON, f"baseline checksum drift {bj_sha}"
assert baseline_count == 117, f"baseline count {baseline_count}"
print("baseline_ok", baseline_count, bj_sha)

# CRM: all NEW on live (loss=0 means no unexpected CRM mutation from shadow)
# Shadow-only: just confirm DISABLE_LIVE_DB in unit
unit = Path("/etc/systemd/system/giorgio-revalidate.service").read_text()
assert "DISABLE_LIVE_DB=true" in unit
assert "shadow-revalidate.db" in unit
print("apply_live_disabled_ok")

subprocess.check_call(["systemctl", "start", "giorgio-revalidate"])
time.sleep(5)
active = subprocess.check_output(["systemctl", "is-active", "giorgio-revalidate"], text=True).strip()
assert active == "active", active

cp = json.loads(CP.read_text())
s = cp.get("stats") or {}
out = {
    "service": active,
    "ENGINE_LOGICAL_SHA": CERT,
    "engineFileHashes": hashes,
    "checkpointShaBeforeResume": cp_sha_before,
    "checkpointShaAfterStart": hashlib.sha256(CP.read_bytes()).hexdigest(),
    "processed": s.get("processed"),
    "terminal": len(cp.get("terminal") or {}),
    "inProgress": len(cp.get("inProgress") or {}),
    "retryQueue": len(cp.get("retryQueue") or {}),
    "hot": s.get("hot"),
    "review": s.get("review"),
    "retry": s.get("retry"),
    "published": s.get("published"),
    "technical": s.get("technical"),
    "baselineCount": baseline_count,
    "baselineSha": bj_sha,
    "applyLiveExecuted": 0,
}
print(json.dumps(out, indent=2))
