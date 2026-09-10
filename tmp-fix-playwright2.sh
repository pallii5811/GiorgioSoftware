#!/bin/bash
set -euo pipefail

# Install browsers into worker's cache (not root)
mkdir -p /home/worker/.cache
if [[ -d /root/.cache/ms-playwright ]]; then
  rm -rf /home/worker/.cache/ms-playwright
  cp -a /root/.cache/ms-playwright /home/worker/.cache/ms-playwright
fi
chown -R worker:worker /home/worker/.cache

# Also install via worker user to be sure
sudo -u worker -H bash -lc 'cd /home/worker/app && /home/worker/app/venv/bin/playwright install chromium'

echo "=== verify paths ==="
ls -la /home/worker/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell
test -x /home/worker/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell

# smoke launch as worker
sudo -u worker -H bash -lc 'cd /home/worker/app && /home/worker/app/venv/bin/python - <<"PY"
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    print("launch_ok", b.version)
    b.close()
PY'

# requeue failed job
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

systemctl restart mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
sleep 3
systemctl is-active mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
echo DONE
