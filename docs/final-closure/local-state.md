# Local state inventory — final closure 2026-07-19

**Captured at:** 2026-07-19 (local)
**Branch:** `cto/final-production-grade-20260719`
**HEAD:** `aae47eb1f37c52bc71f7263814161691b5e88b2b`
**Engine commit:** `684746c`

## Working tree at inventory

- Modified tracked: none
- Untracked: `prisma/data/shadow/db/giorgio-shadow-closure-20260719.db` (+ shm/wal)

## Decision on `prisma/data/`

- Contents: local SQLite shadow copy (~32KB empty/scaffold), **not** production.
- Action: **gitignore** `prisma/data/` — never commit DBs or live copies.
- Not deleted (inventory preserved on disk).
- Live DB: untouched.

## Shadow sources available (gitignored under data/shadow)

- `data/shadow/db/giorgio-live-backup-20260718.db` (immutable backup)
- `data/shadow/db/giorgio-shadow-closure-20260719.db`

## Declared blockers to close this sprint

1. Frontier persistence + resume
2. Waterfall wired into production runner
3. analyzeRegional full identity
4. Gare ANAC enrichment pipeline
5. Shadow benchmark 20+20+20 / 25+25 on this HEAD

## Safety

- No `git reset --hard` / `git clean -fd`
- No deploy / no live writes / no main merge
