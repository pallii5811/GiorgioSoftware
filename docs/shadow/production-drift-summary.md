# Production drift summary (read-only)

**Classification:** `METADATA_ONLY`  
**Compared:** immutable backup SHA `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` vs live file hash `a9229b1537632c94a4b492ee185cb39c96bc86072ac283e9010a0f09b3710da9`  
**Generated:** 2026-07-18T21:51:54Z  

## Temporal rule

Tutti i risultati dello shadow si riferiscono allo snapshot con SHA `cfb9e878…` e **non** includono modifiche di produzione successive.  
Un futuro riallineamento richiede nuovo snapshot, SHA, manifest e report — non merge riga-per-riga dal live.

## Table comparison

| Table | Backup rows | Live rows | Δ | max createdAt | max updatedAt | max PK |
|-------|-------------|-----------|---|---------------|---------------|--------|
| Lead | 1237 | 1237 | 0 | equal | equal | equal |

No tables only-in-backup or only-in-live. Schema for this snapshot is single-table (`Lead`).

## Lead logical diff

| Dimension | Count |
|-----------|------:|
| IDs only in backup | 0 |
| IDs only in live | 0 |
| Shared IDs | 1237 |
| Evidence fingerprint changes | 0 |
| Website changes | 0 |
| Region changes | 0 |
| Score changes | 0 |
| `lastScannedAt` changes | 0 |
| `updatedAt` changes | 0 |
| Verdict token changes | 0 |
| Verdict transitions | none |

## Binary vs logical

- Live SQLite **file hash differs** from the immutable backup.
- All compared logical lead fields and aggregate maxima are **identical**.
- Live quarantine / shadow hist / evidence-version markers: **0 / 0 / 0**.

Therefore the drift is classified as **`METADATA_ONLY`** (SQLite physical layout / freelist / page housekeeping or equivalent), not lead-data or verdict drift.

Not assumed “innocent” without this check: the classification rests on the field-level comparison above, not on the binary hash alone.

## Categories considered

| Category | Selected |
|----------|----------|
| `NO_LOGICAL_DRIFT` | no (file hash differs) |
| `METADATA_ONLY` | **yes** |
| `EXPECTED_PRODUCTION_ACTIVITY` | no (zero field updates) |
| `LEAD_DATA_CHANGED` | no |
| `VERDICT_CHANGED` | no |
| `UNEXPLAINED_DRIFT` | no |

## Artifact

Aggregate only (no PII): `data/shadow/drift/aggregate-diff.json`  
Full row-level dumps with real data must remain gitignored under `data/shadow/drift/`.
