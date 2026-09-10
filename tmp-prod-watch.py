#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
print(
    json.dumps(
        {
            "service": subprocess.run(
                ["systemctl", "is-active", "giorgio-revalidate"], capture_output=True, text=True
            ).stdout.strip(),
            "terminal": len(cp.get("terminal") or {}),
            "retry": len(cp.get("retryQueue") or {}),
            "inProgress": cp.get("inProgress") or {},
            "updatedAt": cp.get("updatedAt"),
        },
        indent=2,
        default=str,
    )
)

log = Path("/opt/leadsniper-revalidate/logs/systemd-revalidate.log").read_text(errors="replace").splitlines()
starts = [i for i, l in enumerate(log) if "revalidate_v3_start" in l]
i = starts[-1] if starts else 0
print("START", log[i][:350])
for l in log[i:]:
    if any(
        k in l
        for k in (
            "lead_done",
            "retry_ceiling",
            "frontier_fresh",
            "frontier_resume",
            "frontier_force",
            "worker_done",
        )
    ):
        print(l[:420])

v3 = Path("/opt/leadsniper-revalidate/app/scripts/production-revalidate-sanita-v3.mjs").read_text()
print(
    "CODE",
    {
        "tech_blocked_ceiling": "retry_ceiling_technical_blocked" in v3,
        "fair_queue": "buildFairQueue" in v3,
        "keep_operational": "retry_ceiling_keep_operational" in v3,
    },
)
