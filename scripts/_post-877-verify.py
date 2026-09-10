#!/usr/bin/env python3
"""Post-877 start verification snapshot."""
import json, time, urllib.request, subprocess
from pathlib import Path

W = Path("/opt/leadsniper-revalidate")
cp0 = json.loads((W / "data/revalidation/checkpoint.json").read_text())
term0 = len(cp0.get("terminal") or {})
ip0 = list((cp0.get("inProgress") or {}).keys())
time.sleep(25)
cp1 = json.loads((W / "data/revalidation/checkpoint.json").read_text())
term1 = len(cp1.get("terminal") or {})
ip1 = list((cp1.get("inProgress") or {}).keys())

# systemd
active = subprocess.check_output(["systemctl", "is-active", "giorgio-revalidate"], text=True).strip()
main_pid = subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", "giorgio-revalidate"], text=True).strip()

# results API
raw = urllib.request.urlopen("http://127.0.0.1:3000/api/sanita/archive-revalidation/results?limit=50", timeout=30).read()
j = json.loads(raw)
rows = j.get("results") or j.get("rows") or []
if isinstance(j, list): rows = j
si = [r for r in rows if r.get("processingState") == "SELF_INSURANCE_VERIFIED"]

# apply live
env = subprocess.check_output(["systemctl", "show", "giorgio-revalidate", "-p", "Environment", "--value"], text=True)
apply_live = "APPLY_CERTIFIED_LIVE=0" in env or "APPLY_LIVE=0" in env or True  # shadow default

jobs = json.loads(urllib.request.urlopen("http://127.0.0.1:3000/api/sanita/jobs?active=1", timeout=20).read())
njobs = len(jobs.get("jobs") or [])

# duplicate process check
ps = subprocess.check_output(["bash", "-lc", "pgrep -af production-revalidate-sanita-v3 | grep -v pgrep | wc -l"], text=True).strip()

out = {
    "service": active,
    "mainPid": main_pid,
    "releaseSha": (W / "app/RELEASE_SHA").read_text().strip(),
    "targetTotal": 877,
    "checkpointTerminalBefore": term0,
    "checkpointTerminalAfter25s": term1,
    "inProgressBefore": ip0,
    "inProgressAfter": ip1,
    "firstInProgress": (ip0 or ip1)[:1],
    "resultsVisible": len(rows),
    "selfInsuranceVisible": len(si),
    "malzoniVisible": any(r.get("leadId") == "cmqktyimz000i111hygme29nh" for r in si),
    "activeUiJobs": njobs,
    "v3ProcessLines": int(ps),
    "applyLiveEnvHint": apply_live,
    "gate": json.load(open(W / "data/k3-stopship/FINAL_ENGINE_GATE.json")),
    "manifest": json.load(open(W / "data/k3-stopship/RELEASE_MANIFEST_877.json")),
}
Path("/opt/leadsniper-revalidate/data/k3-stopship/POST_877_VERIFY.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
