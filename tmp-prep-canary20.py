#!/usr/bin/env python3
"""Build isolated canary-20 workdir without touching production checkpoint."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

APP = Path("/opt/leadsniper-revalidate/app")
PROD_CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
CANARY = Path("/opt/leadsniper-revalidate/data/stopship-canary20")
OUT = CANARY / "CANARY20_REPORT.json"


def sha(p: Path) -> str | None:
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    if CANARY.exists():
        shutil.rmtree(CANARY)
    (CANARY / "frontiers").mkdir(parents=True)
    (CANARY / "results").mkdir(parents=True)
    (CANARY / "locks").mkdir(parents=True)

    prod_sha = sha(PROD_CP)
    # find prisma db
    db_candidates = [
        Path("/opt/leadsniper-revalidate/data/prisma/dev.db"),
        Path("/opt/leadsniper-revalidate/app/prisma/dev.db"),
        Path("/opt/leadsniper/data/prisma/dev.db"),
    ]
    db_sha = None
    db_path = None
    for p in db_candidates:
        if p.exists():
            db_path = p
            db_sha = sha(p)
            break

    cp = json.loads(PROD_CP.read_text())
    terminal_ids = set((cp.get("terminal") or {}).keys())

    # Select 20 mixed leads via node+prisma in app cwd
    selector = r"""
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const terminal = new Set(%s);
(async () => {
  const rows = await p.lead.findMany({
    where: { sector: 'SANITA', region: { in: ['Campania', 'CAMPANIA'] } },
    select: { id: true, companyName: true, website: true, evidence: true },
    take: 400,
  }).catch(async () => {
    return p.lead.findMany({
      select: { id: true, companyName: true, website: true, evidence: true },
      take: 400,
    });
  });
  const fresh = rows.filter((r) => !terminal.has(r.id) && r.website);
  // diversify by hostname
  const seen = new Set();
  const picked = [];
  for (const r of fresh) {
    let host = '';
    try { host = new URL(r.website.startsWith('http') ? r.website : 'https://' + r.website).hostname; } catch { host = r.website; }
    if (seen.has(host)) continue;
    seen.add(host);
    picked.push({ id: r.id, companyName: r.companyName, website: r.website, host });
    if (picked.length >= 20) break;
  }
  console.log(JSON.stringify(picked, null, 2));
  await p.$disconnect();
})().catch((e) => { console.error(String(e)); process.exit(1); });
""" % json.dumps(sorted(terminal_ids))

    Path("/tmp/pick-canary20.mjs").write_text(selector)
    env = os.environ.copy()
    # load DATABASE_URL from systemd unit EnvironmentFile / show
    try:
        show = subprocess.check_output(
            ["systemctl", "show", "giorgio-revalidate", "-p", "Environment", "--value"],
            text=True,
        )
        for part in show.split(" "):
            if "=" in part:
                k, _, v = part.partition("=")
                if k.isupper():
                    env[k] = v
    except Exception:
        pass
    out = subprocess.check_output(
        ["node", "/tmp/pick-canary20.mjs"], cwd=str(APP), env=env, text=True
    )
    picked = json.loads(out)
    ids = [x["id"] for x in picked]
    assert len(ids) >= 15, f"only picked {len(ids)}"

    canary_cp = {
        "version": 3,
        "testedCodeSha": "stopship-canary20",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "terminal": {},
        "retryQueue": {},
        "inProgress": {},
        "attempts": {},
        "stats": {
            "processed": 0,
            "terminal": 0,
            "hot": 0,
            "pub": 0,
            "review": 0,
            "retry": 0,
            "tech": 0,
            "outOfScope": 0,
            "errors": 0,
        },
    }
    (CANARY / "checkpoint.json").write_text(json.dumps(canary_cp, indent=2))
    (CANARY / "ids.json").write_text(json.dumps({"ids": ids, "picked": picked}, indent=2))
    (CANARY / "baseline.json").write_text(
        json.dumps(
            {
                "prodCheckpointSha": prod_sha,
                "dbPath": str(db_path) if db_path else None,
                "dbSha": db_sha,
                "frozenAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
    )
    print(json.dumps({"canaryDir": str(CANARY), "n": len(ids), "ids": ids, "prodSha": prod_sha, "dbSha": db_sha}, indent=2))


if __name__ == "__main__":
    main()
