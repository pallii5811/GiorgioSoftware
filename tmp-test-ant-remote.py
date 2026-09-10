#!/usr/bin/env python3
import json, urllib.request, ssl
from pathlib import Path

env = {}
for line in Path("/home/worker/app/backend/.env").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
key = env["ANTHROPIC_API_KEY"]
body = {
    "model": env.get("ANTHROPIC_MODEL") or "claude-3-5-haiku-latest",
    "max_tokens": 200,
    "temperature": 0,
    "system": 'Rispondi SOLO JSON: {"category":"...","location":"..."}',
    "messages": [{"role": "user", "content": "imprese di pulizia a milano"}],
}
ctx = ssl.create_default_context()
req = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(body).encode(),
    headers={
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
    },
)
with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
    d = json.loads(r.read().decode())
text = "".join(b.get("text", "") for b in (d.get("content") or []) if b.get("type") == "text")
print("OK", text[:300])
