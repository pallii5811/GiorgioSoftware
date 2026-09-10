import json, urllib.request
from pathlib import Path
env = {}
for line in Path("/home/worker/app/backend/.env").read_text().splitlines():
    s = line.strip()
    if not s or s.startswith("#") or "=" not in s:
        continue
    k, v = s.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")
body = json.dumps({
    "system": "Estrai JSON con campi category,city. Solo JSON.",
    "user": "imprese di pulizia a milano",
    "json": True,
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:8001/llm-chat",
    data=body,
    headers={"content-type": "application/json"},
)
print("llm", urllib.request.urlopen(req, timeout=40).read()[:500].decode())
url = env["SUPABASE_URL"].rstrip("/") + "/rest/v1/searches?select=id,status,query,created_at&order=created_at.desc&limit=5"
req2 = urllib.request.Request(
    url,
    headers={
        "apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
        "Authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
    },
)
print("recent", urllib.request.urlopen(req2, timeout=20).read()[:900].decode())
