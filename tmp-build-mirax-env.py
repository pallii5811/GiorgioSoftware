#!/usr/bin/env python3
from pathlib import Path
import os

def kv(text: str) -> dict[str, str]:
    d: dict[str, str] = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        d[k.strip()] = v
    return d

dev = Path(r"c:\Users\Simone\CascadeProjects\WEB APP CKB - Dev\backend_mirror\.env").read_text(encoding="utf-8-sig")
copia = Path(r"c:\Users\Simone\CascadeProjects\WEB APP CKB - Copia\.env.local").read_text(encoding="utf-8-sig")
dd, cd = kv(dev), kv(copia)
out = {
    "SUPABASE_URL": cd.get("NEXT_PUBLIC_SUPABASE_URL") or dd.get("SUPABASE_URL") or "",
    "SUPABASE_SERVICE_ROLE_KEY": cd.get("SUPABASE_SERVICE_ROLE_KEY") or dd.get("SUPABASE_SERVICE_ROLE_KEY") or "",
    "DEMO_MAX_RESULTS": dd.get("DEMO_MAX_RESULTS", "50"),
    "SERPER_API_KEY": dd.get("SERPER_API_KEY", ""),
    "OPENAI_API_KEY": cd.get("OPENAI_API_KEY", ""),
    "ENRICH_BUSINESS_EVENTS": "1",
    "ORGANIC_DISCOVERY_ENABLED": "1",
    "AGENTIC_GAP_FILL_ENABLED": "1",
    "MIRAX_WORKER_DISABLED": "0",
    "USER_RECENT_MINUTES": "0",
    "MIRAX_RELEASE_ID": "20260723_prod_migrate",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/snap/bin/chromium",
    "CHROMIUM_PATH": "/snap/bin/chromium",
}
assert out["SUPABASE_URL"] and out["SUPABASE_SERVICE_ROLE_KEY"], "missing supabase"
dest = Path(os.environ["TEMP"]) / "mirax-backend.env"
lines = ["# mirax prod migrate — do not commit"] + [f"{k}={v}" for k, v in out.items()]
dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("wrote", dest)
print("keys", sorted(out))
print("supabase_host", out["SUPABASE_URL"].split("//")[-1][:48])
