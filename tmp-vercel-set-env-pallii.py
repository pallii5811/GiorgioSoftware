#!/usr/bin/env python3
"""Upsert Mirax production env on pallii5811 miraxgroupckb."""
from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\Users\Simone\CascadeProjects\WEB APP CKB - Copia")
AUTH = Path(r"C:\Users\Simone\AppData\Roaming\com.vercel.cli\Data\auth.json")
TEAM = "team_X7D9h4V5eKPGS6TGHfOR3DPx"
PROJECT = "prj_b1zkMvlt5Mh4b0RBLYY4qQRPKjoW"
CTX = ssl._create_unverified_context()
TOKEN = json.loads(AUTH.read_text(encoding="utf-8"))["token"]


def api(method: str, url: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except Exception:
            payload = {"raw": raw[:500]}
        return e.code, payload


def load_local() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main() -> None:
    local = load_local()
    wanted = {
        "ANTHROPIC_API_KEY": local.get("ANTHROPIC_API_KEY") or "",
        "ANTHROPIC_MODEL": local.get("ANTHROPIC_MODEL") or "claude-haiku-4-5",
        "BACKEND_URL": "http://167.233.62.125:8001",
        "NEXT_PUBLIC_SITE_URL": "https://www.miraxgroup.it",
    }
    if not wanted["ANTHROPIC_API_KEY"]:
        raise SystemExit("missing ANTHROPIC_API_KEY in .env.local")

    code, data = api("GET", f"https://api.vercel.com/v9/projects/{PROJECT}/env?teamId={TEAM}")
    by_key = {e.get("key"): e for e in (data.get("envs") or [])}
    print("env_list", code, "count", len(by_key))

    for key, value in wanted.items():
        if key in by_key:
            eid = by_key[key]["id"]
            c, d = api(
                "PATCH",
                f"https://api.vercel.com/v9/projects/{PROJECT}/env/{eid}?teamId={TEAM}",
                {
                    "value": value,
                    "type": "encrypted",
                    "target": ["production", "preview", "development"],
                },
            )
            print("PATCH", key, c, "ok" if c in (200, 201) else d)
        else:
            c, d = api(
                "POST",
                f"https://api.vercel.com/v10/projects/{PROJECT}/env?teamId={TEAM}",
                {
                    "key": key,
                    "value": value,
                    "type": "encrypted",
                    "target": ["production", "preview", "development"],
                },
            )
            print("POST", key, c, "ok" if c in (200, 201) else d)


if __name__ == "__main__":
    main()
