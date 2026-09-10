#!/usr/bin/env bash
set -euo pipefail
echo "REVAL=$(systemctl is-active giorgio-revalidate)"
echo "UPTIME=$(systemctl show giorgio-revalidate -p ActiveEnterTimestamp --value)"
echo "MAINPID=$(systemctl show giorgio-revalidate -p MainPID --value)"
python3 <<'PY'
import json, os, time, subprocess
from collections import Counter
cp_path="/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
cp=json.load(open(cp_path))
done=cp.get("done") or {}
stats=cp.get("stats") or {}
print("CP_SHA", subprocess.check_output(["sha256sum",cp_path], text=True).split()[0])
print("CP_MTIME", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(os.path.getmtime(cp_path))))
print("DONE_COUNT", len(done))
print("STATS_JSON", json.dumps(stats)[:3000])
print("TOP_KEYS", sorted(cp.keys())[:50])
for k in ["total","pending","phase","concurrency","testedCodeSha","startedAt","updatedAt","mode","resumeFrom"]:
    if k in cp:
        print(f"CP_{k}", cp[k])
c=Counter()
for v in done.values():
    if isinstance(v, dict):
        st=v.get("processingState") or v.get("state") or v.get("businessVerdict") or v.get("verdict") or "?"
        c[str(st)] += 1
    else:
        c["non_dict"] += 1
print("DONE_STATES", dict(c.most_common(30)))
# results dir if any
res="/opt/leadsniper-revalidate/data/revalidation"
print("RES_DIR", sorted(os.listdir(res))[:40])
PY
echo "--- recent journal ---"
journalctl -u giorgio-revalidate -n 30 --no-pager -o cat
