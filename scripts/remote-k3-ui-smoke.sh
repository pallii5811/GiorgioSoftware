#!/usr/bin/env bash
set -euo pipefail
echo "sanita=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/sanita)"
curl -sS 'http://127.0.0.1:3000/api/sanita/archive-revalidation/results?scope=working&limit=5' -o /tmp/w.json
python3 - <<'PY'
import json
d=json.load(open("/tmp/w.json"))
print("working_ok", d.get("success"), "n", len(d.get("results") or []))
PY
curl -sS -X POST http://127.0.0.1:3000/api/sanita/archive-revalidation/control \
  -H 'Content-Type: application/json' -d '{"action":"start"}' -o /tmp/s1.json
curl -sS -X POST http://127.0.0.1:3000/api/sanita/archive-revalidation/control \
  -H 'Content-Type: application/json' -d '{"action":"start"}' -o /tmp/s2.json
python3 - <<'PY'
import json
s1=json.load(open("/tmp/s1.json")); s2=json.load(open("/tmp/s2.json"))
print("start1", s1.get("success"), s1.get("error") or s1.get("statusLabel") or s1.get("jobId"))
print("start2", s2.get("success"), s2.get("error") or s2.get("status") or list(s2.keys())[:6])
# pause if we started
if s1.get("success"):
  import urllib.request
  req=urllib.request.Request("http://127.0.0.1:3000/api/sanita/archive-revalidation/control", data=b'{"action":"pause"}', headers={"Content-Type":"application/json"}, method="POST")
  print("pause", urllib.request.urlopen(req).read()[:200])
PY
echo "RELEASE=$(cat /opt/leadsniper/RELEASE_SHA)"
systemctl is-active giorgio-revalidate || true
pgrep -af 'production-revalidate-sanita-v3' | grep -v pgrep || echo no_v3
