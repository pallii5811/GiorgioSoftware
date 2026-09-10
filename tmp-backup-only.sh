#!/bin/bash
# Backup only — no DB wipe, no scan start
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/leadsniper-backups/pre-k3-tip-$TS
mkdir -p "$BK"
cp -a /opt/leadsniper/prisma/dev.db "$BK/dev.db"
cp -a /opt/leadsniper-revalidate/shadow-revalidate.db "$BK/shadow-revalidate.db" 2>/dev/null || true
cp -a /opt/leadsniper/RELEASE_SHA "$BK/RELEASE_SHA.ui" 2>/dev/null || true
cp -a /opt/leadsniper-revalidate/app/RELEASE_SHA "$BK/RELEASE_SHA.app" 2>/dev/null || true
cp -a /opt/leadsniper/.env "$BK/env.ui" 2>/dev/null || true
cp -a /etc/systemd/system/giorgio-revalidate.service "$BK/giorgio-revalidate.service" 2>/dev/null || true
cp -a /opt/leadsniper-revalidate/data/revalidation/checkpoint.json "$BK/checkpoint.json" 2>/dev/null || true
sha256sum "$BK/dev.db" | tee "$BK/dev.db.sha256"
python3 - <<PY
import sqlite3
c=sqlite3.connect("/opt/leadsniper/prisma/dev.db")
print({"hc": c.execute("select count(*) from Lead where type='HEALTHCARE'").fetchone()[0],
       "total": c.execute("select count(*) from Lead").fetchone()[0]})
PY
echo "BACKUP_OK $BK"
