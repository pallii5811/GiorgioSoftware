#!/usr/bin/env python3
"""Deploy Mirax CKB to simodepertis team (CLI has write access there)."""
from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\Users\Simone\CascadeProjects\WEB APP CKB - Copia")
AUTH = Path(r"C:\Users\Simone\AppData\Roaming\com.vercel.cli\Data\auth.json")
TEAM_ID = "team_YjA3pbr3ScsUDvSCaFA2nhcb"
PROJECT_NAME = "miraxgroupckb-live"
CTX = ssl._create_unverified_context()

TOKEN = json.loads(AUTH.read_text(encoding="utf-8"))["token"]


def api(method: str, url: str, body: dict | None = None, timeout: int = 120):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except Exception:
            payload = {"raw": raw[:800]}
        return e.code, payload


def load_env_local() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    # Force production backend + anthropic model
    out["BACKEND_URL"] = "http://167.233.62.125:8001"
    out.setdefault("ANTHROPIC_MODEL", "claude-haiku-4-5")
    out["NEXT_PUBLIC_SITE_URL"] = "https://miraxgroupckb-live.vercel.app"
    return out


def ensure_project() -> str:
    code, data = api(
        "GET",
        f"https://api.vercel.com/v9/projects/{PROJECT_NAME}?teamId={TEAM_ID}",
    )
    if code == 200 and data.get("id"):
        print("project_exists", data["id"])
        return data["id"]
    code, data = api(
        "POST",
        f"https://api.vercel.com/v10/projects?teamId={TEAM_ID}",
        {
            "name": PROJECT_NAME,
            "framework": "nextjs",
            "gitRepository": {
                "type": "github",
                "repo": "pallii5811/miraxgroupckb",
            },
        },
    )
    print("create_project", code, {k: data.get(k) for k in ("id", "name", "error", "code", "message")})
    if code in (200, 201) and data.get("id"):
        return data["id"]
    # create without git link
    code, data = api(
        "POST",
        f"https://api.vercel.com/v10/projects?teamId={TEAM_ID}",
        {"name": PROJECT_NAME, "framework": "nextjs"},
    )
    print("create_project_nogit", code, {k: data.get(k) for k in ("id", "name", "error", "code", "message")})
    if code not in (200, 201) or not data.get("id"):
        raise SystemExit(f"cannot create project: {data}")
    return data["id"]


def upsert_env(project_id: str, env: dict[str, str]) -> None:
    code, data = api(
        "GET",
        f"https://api.vercel.com/v9/projects/{project_id}/env?teamId={TEAM_ID}",
    )
    existing = {(e.get("key"), e.get("id")) for e in (data.get("envs") or [])}
    by_key = {e.get("key"): e for e in (data.get("envs") or [])}
    print("env_list", code, "count", len(by_key))
    for key, value in env.items():
        if key in by_key:
            eid = by_key[key]["id"]
            c, d = api(
                "PATCH",
                f"https://api.vercel.com/v9/projects/{project_id}/env/{eid}?teamId={TEAM_ID}",
                {"value": value, "type": "encrypted", "target": ["production", "preview", "development"]},
            )
            print("PATCH", key, c, d.get("error") or d.get("code") or "ok")
        else:
            c, d = api(
                "POST",
                f"https://api.vercel.com/v10/projects/{project_id}/env?teamId={TEAM_ID}",
                {
                    "key": key,
                    "value": value,
                    "type": "encrypted",
                    "target": ["production", "preview", "development"],
                },
            )
            print("POST", key, c, d.get("error") or d.get("code") or "ok")


def redeploy_from_git(project_id: str) -> None:
    # Prefer creating deployment from git sha on main
    code, data = api(
        "POST",
        f"https://api.vercel.com/v13/deployments?teamId={TEAM_ID}&forceNew=1",
        {
            "name": PROJECT_NAME,
            "project": project_id,
            "target": "production",
            "gitSource": {
                "type": "github",
                "org": "pallii5811",
                "repo": "miraxgroupckb",
                "ref": "main",
            },
        },
        timeout=180,
    )
    print(
        "deploy",
        code,
        {
            "id": data.get("id"),
            "url": data.get("url"),
            "readyState": data.get("readyState"),
            "error": data.get("error"),
            "code": data.get("code"),
            "message": data.get("message"),
        },
    )
    dep_id = data.get("id")
    if not dep_id:
        return
    for i in range(60):
        time.sleep(5)
        c, d = api("GET", f"https://api.vercel.com/v13/deployments/{dep_id}?teamId={TEAM_ID}")
        state = d.get("readyState") or d.get("status")
        print("poll", i, state, d.get("url"))
        if state in ("READY", "ERROR", "CANCELED", "BLOCKED"):
            print("final", {k: d.get(k) for k in ("readyState", "url", "aliasError", "errorMessage", "errorCode")})
            break


def main() -> None:
    env = load_env_local()
    print("env_keys", sorted(env.keys()))
    print("has_anthropic", bool(env.get("ANTHROPIC_API_KEY")))
    print("backend", env.get("BACKEND_URL"))
    pid = ensure_project()
    upsert_env(pid, env)
    redeploy_from_git(pid)


if __name__ == "__main__":
    main()
