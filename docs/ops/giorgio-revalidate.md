# Giorgio revalidation systemd unit (sanitized template)

Deploy on Hetzner as `/etc/systemd/system/giorgio-revalidate.service`.

Do **not** put secrets in this file. `DATABASE_URL` must point at the **shadow** SQLite only.

Key invariants:

- `SCAN_FAST=0`
- `OCR_ENABLED=1`
- `POLICY_EXHAUSTIVE=1`
- `REVALIDATE_DUAL_HOT=1`
- `REVALIDATE_CHECKPOINT` preserved across restarts
- `TimeoutStopSec` large enough for current lead to finish
- `KillSignal=SIGTERM` (no kill -9 for normal stop)

See committed template beside this file: `giorgio-revalidate.service.template`.

Runtime entrypoint:

```bash
npx tsx scripts/production-revalidate-sanita-v3.mjs
```

Workers are spawned as isolated child processes (`production-revalidate-sanita-worker.mjs`).
