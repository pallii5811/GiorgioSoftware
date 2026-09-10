#!/usr/bin/env python3
"""Resolve lead labels from prisma sqlite/postgres via env in unit."""
import json
import os
import re
import subprocess
from pathlib import Path

ids = [
    "cmqkld5t200au108eefkj9viq",
    "cmqkld5s3009z108e1yj01zqy",
    "cmqkld5t300av108e5rrr47s9",
]

# Prefer reading company from frontier CrawlRun or from a known leads dump
for p in Path("/opt/leadsniper-revalidate/data").rglob("*candidates*"):
    print("cand", p)
# check systemd env for DATABASE_URL
out = subprocess.check_output(
    ["systemctl", "show", "giorgio-revalidate", "-p", "Environment", "--value"],
    text=True,
)
# don't print secrets; just use node with prisma from app
script = r"""
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const ids = %s;
(async () => {
  try {
    const rows = await p.lead.findMany({
      where: { id: { in: ids } },
      select: { id: true, companyName: true, website: true, name: true },
    });
    console.log(JSON.stringify(rows, null, 2));
  } catch (e1) {
    try {
      const rows = await p.sanitaLead.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, website: true },
      });
      console.log(JSON.stringify(rows, null, 2));
    } catch (e2) {
      console.log(JSON.stringify({ err1: String(e1), err2: String(e2) }));
    }
  } finally {
    await p.$disconnect().catch(() => {});
  }
})();
""" % json.dumps(ids)

Path("/tmp/lead-names.mjs").write_text(script)
os.chdir("/opt/leadsniper-revalidate/app")
# load env from service drop-ins without dumping
env = os.environ.copy()
for line in out.split(" "):
    if "=" in line and not line.startswith("Environment"):
        k, _, v = line.partition("=")
        if k and k.isupper():
            env[k] = v
r = subprocess.run(["node", "/tmp/lead-names.mjs"], capture_output=True, text=True, env=env, cwd="/opt/leadsniper-revalidate/app")
print(r.stdout or r.stderr)
