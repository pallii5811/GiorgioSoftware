# Restore re-run verification — `giorgio-shadow-20260718-rerun`

**Verdict:** PASS  
**Generated:** 2026-07-18 (continuation after SSH hang)

## Temporal rule

Tutti i risultati dello shadow si riferiscono allo snapshot con SHA `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` e non includono modifiche di produzione successive.

Il DB shadow precedente (`giorgio-shadow-20260718.db`, già quarantinato) **non** è stato riusato.

## Procedure

1. Verify immutable backup SHA (local copy).
2. Fresh copy → `data/shadow/db/giorgio-shadow-20260718-rerun.db`.
3. Integrity + counts + zero prior shadow markers.
4. Quarantine only on rerun DB (see `quarantine-rerun.json`).

## Expected vs obtained

| Check | Expected | Obtained | Result |
|-------|----------|----------|--------|
| SHA-256 | `cfb9e878…063ab` | `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` | PASS |
| Size | 2_007_040 | 2_007_040 | PASS |
| Integrity | ok | ok | PASS |
| Tables | 1 (`Lead`) | 1 (`Lead`) | PASS |
| Lead total | 1237 | 1237 | PASS |
| HOT | 515 | 515 | PASS |
| PUBLISHED | 120 | 120 | PASS |
| REVIEW | 242 | 242 | PASS |
| HEALTHCARE | 877 | 877 | PASS |
| TENDER | 360 | 360 | PASS |
| Campania (sanità) | 511 | 511 | PASS |
| Veneto (sanità) | 366 | 366 | PASS |
| Prior quarantine markers | 0 | 0 | PASS |
| Prior `SHADOW_HIST_VERDICT` | 0 | 0 | PASS |
| Prior `[EV_V:` markers | 0 | 0 | PASS |
| max `lastScannedAt` | 1782911944592 | 1782911944592 | PASS |

## Isolation

- Live DB: not opened for write by restore.
- Backup file: not overwritten.
- Old shadow DB: left untouched (historical quarantine artifacts only).

## Artifacts

- `docs/shadow/restore-rerun.json`
- `docs/shadow/verify-backup.json`
- `docs/shadow/shadow-snapshot-manifest.json`
