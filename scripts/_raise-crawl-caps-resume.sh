#!/usr/bin/env bash
# Raise crawl caps mid-run via systemd drop-in + graceful resume.
# Preserves checkpoint. Does NOT wipe frontier/results/DB.
set -euo pipefail
BK=/opt/leadsniper-revalidate/data/k3-stopship/backups/cap-raise-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BK"
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
sha256sum "$CP" | tee "$BK/checkpoint.before.sha"
cp -a "$CP" "$BK/checkpoint.json"
echo "PRE_PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
python3 - <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("PRE", {k:len(cp.get(k) or {}) for k in ["terminal","inProgress","retryQueue"]}, "updatedAt", cp.get("updatedAt"))
PY

mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/crawl-caps.conf <<'EOF'
[Service]
# Stop-ship throughput: 40 HTML URLs left relevant links open → systemic CRAWL_CAP retries.
Environment=CRAWL_HTML_URL_CAP=100
Environment=CRAWL_MAX_HTML_PER_SLICE=24
Environment=CRAWL_RUN_MAX_WALL_CLOCK_MS=2700000
Environment=REVALIDATE_LEAD_WALL_MS=2700000
EOF

systemctl daemon-reload
# Graceful stop then start → resume from checkpoint (ExecStart is v3 resume path)
systemctl stop giorgio-revalidate
sleep 3
# ensure lock released
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock || true
systemctl start giorgio-revalidate
sleep 8
echo "POST_PID=$(systemctl show -p MainPID --value giorgio-revalidate)"
systemctl is-active giorgio-revalidate
sha256sum "$CP" | tee "$BK/checkpoint.after.sha"
# terminal/retry keys must not shrink
python3 - <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("POST", {k:len(cp.get(k) or {}) for k in ["terminal","inProgress","retryQueue"]}, "updatedAt", cp.get("updatedAt"))
print("env_check")
PY
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value giorgio-revalidate)/environ 2>/dev/null | grep -E 'CRAWL_HTML_URL_CAP|CRAWL_MAX_HTML|LEAD_WALL|RUN_MAX' || \
  systemctl show giorgio-revalidate -p Environment | tr ' ' '\n' | grep -E 'CRAWL_|LEAD_WALL'
echo CAP_RAISE_RESUME_OK backup=$BK
