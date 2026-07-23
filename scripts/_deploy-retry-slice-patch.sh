#!/usr/bin/env bash
# Hotpatch revalidate coordinator (resume/slice/SI terminal) + restart resume. Preserve CP.
set -euo pipefail
APP=/opt/leadsniper-revalidate/app
BK=/opt/leadsniper-revalidate/data/k3-stopship/backups/retry-slice-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BK"
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json
sha256sum "$CP" | tee "$BK/cp.before.sha"
cp -a "$CP" "$BK/checkpoint.json"
cp -a "$APP/scripts/production-revalidate-sanita-v3.mjs" "$BK/" || true
cp -a "$APP/scripts/revalidate-checkpoint-v3.mjs" "$BK/" || true

install -m 0644 /tmp/k3-retry-patch/production-revalidate-sanita-v3.mjs "$APP/scripts/production-revalidate-sanita-v3.mjs"
install -m 0644 /tmp/k3-retry-patch/revalidate-checkpoint-v3.mjs "$APP/scripts/revalidate-checkpoint-v3.mjs"

# Slice wall drop-in (max overall still via boost strategy)
mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/slice-retry.conf <<'EOF'
[Service]
Environment=REVALIDATE_SLICE_WALL_MS=480000
Environment=REVALIDATE_RETRY_BASE_MS=60000
Environment=REVALIDATE_MAX_RETRY=8
Environment=CRAWL_HTML_URL_CAP=100
Environment=CRAWL_MAX_HTML_PER_SLICE=24
Environment=PER_HOST_CONCURRENCY=1
Environment=TOTAL_WORKERS=2
Environment=REVALIDATE_CONCURRENCY=2
EOF

systemctl daemon-reload
echo PRE_PID=$(systemctl show -p MainPID --value giorgio-revalidate)
systemctl stop giorgio-revalidate
sleep 4
rm -f /opt/leadsniper-revalidate/revalidate.parent.lock || true
# freeze sample AFTER stop so parent isn't rewriting CP
python3 /tmp/_freeze-retry20.py | tee "$BK/sample.json"
systemctl start giorgio-revalidate
sleep 6
echo POST_PID=$(systemctl show -p MainPID --value giorgio-revalidate)
systemctl is-active giorgio-revalidate
sha256sum "$CP" | tee "$BK/cp.after.sha"
python3 - <<'PY'
import json
cp=json.load(open("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"))
print("POST", {k:len(cp.get(k) or {}) for k in ["terminal","retryQueue","inProgress"]})
PY
echo HOTPATCH_RETRY_SLICE_OK
