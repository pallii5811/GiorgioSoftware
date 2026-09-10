#!/usr/bin/env python3
import hashlib, json, subprocess
from pathlib import Path

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

cp = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
base = "/opt/leadsniper/backups/published-legacy-baseline-20260721T155725Z/published-legacy-baseline.json"
worker = "/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-worker.mjs"
d = json.loads(Path(cp).read_text())
print(json.dumps({
  "uiReleaseSha": Path("/opt/leadsniper/RELEASE_SHA").read_text().strip(),
  "uiGitHead": subprocess.getoutput("git -C /opt/leadsniper rev-parse HEAD").strip(),
  "reval": subprocess.getoutput("systemctl is-active giorgio-revalidate").strip(),
  "processed": (d.get("stats") or {}).get("processed"),
  "checkpointSha": sha(cp),
  "workerSha": sha(worker),
  "baselineSha": sha(base),
  "baselineCount": json.loads(Path(base).read_text()).get("count"),
  "engineLogical": (json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json").read_text()).get("ENGINE_LOGICAL_SHA") if Path("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json").exists() else None),
  "applyLive": (json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json").read_text()).get("applyLiveExecuted") if Path("/opt/leadsniper-revalidate/data/revalidation/archive-run-meta.json").exists() else None),
}, indent=2))
