#!/usr/bin/env python3
"""Inspect/requeue stuck Mirax searches via Supabase REST."""
from __future__ import annotations
import json, os, urllib.request
from pathlib import Path

def kv(text: str) -> dict[str, str]:
    d = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        d[k.strip()] = v.strip().strip('"').strip("'")
    return d

env = kv(Path(r"c:\Users\Simone\CascadeProjects\WEB APP CKB - Copia\.env.local").read_text(encoding="utf-8-sig"))
url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
key = env["SUPABASE_SERVICE_ROLE_KEY"]

def req(path: str, method="GET", body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        data=data,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else None

# Recent searches
rows = req("searches?select=id,query,status,progress,created_at,updated_at&order=created_at.desc&limit=15")
print("=== RECENT SEARCHES ===")
for r in rows or []:
    prog = r.get("progress")
    if isinstance(prog, dict):
        prog_s = {k: prog.get(k) for k in list(prog)[:6]}
    else:
        prog_s = prog
    print(r.get("status"), (r.get("query") or "")[:50], r.get("id"), prog_s)

stuck = [r for r in (rows or []) if str(r.get("status") or "").lower() in {"running", "processing", "in_progress", "claimed"}]
print("STUCK_N", len(stuck))
# Also pending count
pending = req("searches?select=id&status=eq.pending&limit=50")
print("PENDING_N", len(pending or []))
