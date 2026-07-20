# SSH hang — interrupted shadow run (documented)

## What happened

A prior shadow continuation over SSH hung / was interrupted before this successful re-run. The user confirmed the interrupted attempt was repeated successfully afterward.

## Interrupted context (known)

| Item | Status |
|------|--------|
| Command in flight | Shadow continuation / remote probe over SSH (Hetzner) |
| Last useful checkpoint | Immutable backup already sealed at SHA `cfb9e878…`; quarantine had been applied only to the **old** shadow DB `giorgio-shadow-20260718.db` |
| Live DB modified by hang? | **No** — live quarantine markers remained `0` (re-verified) |
| Process left active on Hetzner | No orphaned shadow worker found after re-run; only production `node` holders of `dev.db` and ephemeral RO python probes |
| SQLite lock on live from shadow | None attributable to shadow scripts |
| Partial shadow files | Old quarantined shadow DB retained as historical; **new** DB `giorgio-shadow-20260718-rerun.db` restored clean from immutable backup |
| Child processes | No lingering shadow quarantine/apply workers |

## Pre-re-run checks (performed)

- Duplicate heavy shadow workers: none active
- Orphan python shadow scripts: only `/tmp/shadow-*.py` source copies + short-lived RO probes
- Live SQLite: held by production `node` (expected — not killed)
- Cron / pm2: not restarted; no production service restart
- Temp files: RO scripts under `/tmp` only
- Disk: sufficient for restore (backup size 2_007_040 bytes)

## Protections added / reinforced

In `scripts/shadow-continuation.py`:

- Exclusive lock file `.shadow-worker.lock` (refuse second heavy worker)
- Heartbeat `.shadow-heartbeat`
- Checkpoint `.shadow-checkpoint.json` per step
- `SHADOW_RUN_ID` / run identifier
- Explicit timeout via `SHADOW_TIMEOUT_SEC` (default 1800s; SIGALRM where available)
- `SIGINT` / `SIGTERM` handlers: release lock, write interrupt checkpoint, exit cleanly
- Resume rule: inspect checkpoint + lock; restore clean from immutable backup if markers already present; never write live

## Root cause

**Unknown** with certainty (SSH session / network stall). No evidence of live DB corruption or quarantine write-through.

## Cleanup policy

- Do **not** kill production `node` processes holding `dev.db`
- Shadow lock files are local under `data/shadow/db/` (gitignored)
- Hetzner `/tmp/shadow-*.py` are disposable RO helpers
