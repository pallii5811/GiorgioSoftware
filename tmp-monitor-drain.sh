#!/usr/bin/env bash
# Campiona il checkpoint ogni 60s per 12 min: terminali, retry, identity, lead in corso.
set -uo pipefail
for i in $(seq 1 13); do
  python3 - <<'PY'
import json, time
from pathlib import Path
cp = json.loads(Path('/opt/leadsniper-revalidate/data/revalidation/checkpoint.json').read_text())
term = cp.get('terminal') or {}
rq = cp.get('retryQueue') or {}
inp = cp.get('inProgress') or {}
ident = sum(1 for v in rq.values() if 'IDENTITY' in f"{v.get('lastReason')} {v.get('lastError')}".upper())
hot = sum(1 for v in term.values() if v.get('processingState') == 'HOT_VERIFIED')
pub = sum(1 for v in term.values() if str(v.get('processingState') or '').startswith('PUBLISHED'))
cur = next(iter(inp.items()), None)
print(f"{time.strftime('%H:%M:%S')} terminal={len(term)} hot={hot} pub={pub} retry={len(rq)} identity={ident} running={cur[0][:12] if cur else '-'} started={(cur[1].get('startedAt') or '')[11:19] if cur else '-'} strat={cur[1].get('strategy') if cur else '-'} resumed={cur[1].get('resumed') if cur else '-'}")
PY
  sleep 60
done
echo "--- errori/eventi recenti ---"
journalctl -u giorgio-revalidate --since '-13 min' --no-pager -o cat | grep -iE 'oom|kill|error|lead_done|identity' | tail -12
