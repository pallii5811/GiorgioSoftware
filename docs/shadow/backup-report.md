# Backup report — Live Hetzner → immutable backup

**Data:** 2026-07-18T20:41:06Z  
**Metodo:** `sqlite3.Connection.backup()` via Python (copia consistente, source non aperta in write dalla procedura shadow)

| Campo | Valore |
|--------|--------|
| Source live | `/opt/leadsniper/prisma/dev.db` |
| Backup path (Hetzner) | `/opt/leadsniper/backups/giorgio-live-20260718.db` |
| Size | 2_007_040 bytes |
| SHA-256 | `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab` |
| Integrity | `ok` |
| Tables | 1 (`Lead`) |
| Lead total | 1237 |
| HEALTHCARE | 877 |
| TENDER | 360 |
| HOT token `[V:HOT]` | **515** (allineato alla stima precedente) |
| PUBLISHED | 120 |
| REVIEW | 242 |
| Sanità Campania | 511 |
| Sanità Veneto | 366 |

**Credenziali:** non incluse.  
**Scritture live da questa procedura:** nessuna (solo API backup read-side).
