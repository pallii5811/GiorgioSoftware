#!/bin/bash
set -euo pipefail
cd /home/worker/app/backend

echo "=== playwright install (worker) ==="
if [[ -x .venv/bin/playwright ]]; then
  sudo -u worker -H bash -lc 'cd /home/worker/app/backend && .venv/bin/playwright install chromium'
elif [[ -x .venv/bin/python ]]; then
  sudo -u worker -H bash -lc 'cd /home/worker/app/backend && .venv/bin/python -m playwright install chromium'
else
  sudo -u worker -H bash -lc 'cd /home/worker/app/backend && python3 -m playwright install chromium'
fi

echo "=== cache listing ==="
ls -la /home/worker/.cache/ms-playwright/ || true
ls -la /home/worker/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/ 2>/dev/null || true
find /home/worker/.cache/ms-playwright -name 'headless_shell' 2>/dev/null | head

echo "=== requeue job ==="
python3 <<'PY'
import json, urllib.request
from pathlib import Path
env = {}
for line in Path("/home/worker/app/backend/.env").read_text().splitlines():
    s = line.strip()
    if not s or s.startswith("#") or "=" not in s:
        continue
    k, v = s.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")
jid = "f98bb3dc-9538-4461-821d-df3f28580eb8"
body = json.dumps({"status": "pending", "results": []}).encode()
url = env["SUPABASE_URL"].rstrip("/") + f"/rest/v1/searches?id=eq.{jid}"
req = urllib.request.Request(
    url,
    data=body,
    method="PATCH",
    headers={
        "apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
        "Authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    },
)
urllib.request.urlopen(req, timeout=20)
print("requeued", jid)
PY

systemctl restart mirax-worker-user mirax-worker-user-2 mirax-worker-backlog mirax-audit-api
sleep 2
systemctl is-active mirax-worker-user mirax-worker-user-2 mirax-worker-backlog mirax-audit-api
echo DONE
