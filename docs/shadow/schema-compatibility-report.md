# Schema compatibility report — Snapshot vs Phase 2 code

| Campo | Valore |
|--------|--------|
| Commit snapshot (live associate) | `ad38748ea59edd936b9c7def3a62fdd5ae9b4e2f` |
| Commit Phase 2 / codice gate | `a7d9ee12d832ab6a6b719ffa7e63367f11e87162` |
| Relazione git | `a7d9ee1` è **antenato** di `ad38748` (Phase 2 già inclusa in HEAD shadow) |
| Diff `ad38748` → `a7d9ee1` (prisma) | **vuoto** |
| Diff `a7d9ee1` → `ad38748` (prisma) | **vuoto** |
| Diff applicativo tra i due | Solo infrastruttura shadow (`src/lib/shadow`, script backup/quarantine) — **nessuna** modifica schema Lead |

## Differenze schema

| Area | Esito |
|------|--------|
| `prisma/schema.prisma` | identico |
| `prisma/schema.sqlite.prisma` | identico |
| Migrazioni Prisma | **assenti** nel repo (solo `db push`) |
| Modello `Lead` | invariato (stessi campi Sanità/Gare) |
| Enum DB | nessuno aggiuntivo |
| Indici / vincoli / default / nullability | invariati |
| Evidence / identity / crawl / verdict version | marker **testuali** in `evidence` (non colonne) — già in codice da Phase 2 |

## Migrazioni

| Voce | Valore |
|------|--------|
| Migrazione necessaria | **no** |
| Migrazioni applicate allo shadow | **0** |
| DDL eseguiti | nessuno |
| SHA DB prima | `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` |
| SHA DB dopo (pre-batch) | invariato (nessun DDL) |
| Righe prima | 1237 |
| Righe dopo | 1237 |
| Integrità | ok |
| Campi valorizzati automaticamente | nessuno |
| Campi rimasti null | n/a (nessuna colonna nuova) |
| Regressioni | nessuna |

## Verdetto

**`COMPATIBLE_NO_MIGRATION`**

Il database shadow restaurato è utilizzabile dal codice corrente senza DDL. I nuovi contratti (EV_V/VD_V, identity, crawl completeness) operano su marker in `evidence` e non richiedono alter table.
