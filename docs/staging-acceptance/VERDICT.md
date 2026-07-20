# LAST MILE RELEASE CLOSURE — VERDETTO

| Campo | Valore |
|-------|--------|
| **Verdetto** | **PRODUCTION RELEASE CANDIDATE — HUMAN SIGN-OFF REQUIRED** |
| testedCodeSha | `d27fff1907e254fab93e1b9c6aa2cd7aa6801b54` |
| Heidy analyzeLead SHA | `597257bf6fcc093f6f88a3edf2c207d4fb71096a` (stesso codice prodotto regionale; commit successivo = solo harness) |
| Branch | `cto/final-production-grade-20260719` |
| Heidy | `HOT` / `HOT_VERIFIED` / `CURRENT_VERIFIED` / crawlComplete=true |
| HOT complete | 1 (Heidy only; Progenia/Simamed/Marigold non rieseguiti) |
| technical→human | 0 |
| Contatori Heidy | hot+1, reviewHuman+0, retryPending+0 |
| Browser semantic | PASS (53/53) |
| Gare artifacts | 25+25, false actionable 0, recall 1.0, provenance ok |
| npm suite | vedi matrice JSON |
| Tree | clean after artifact commit |
| Live effects | **zero** (no deploy, no main, no live DB, no tag) |

## Patch chiuse

1. Regional gate dopo identity + waterfall + final completeness
2. Un solo stato terminale / un solo contatore
3. Completeness markers solo post-waterfall + invariant

## Heidy root cause osservata e corretta

Tavily restituiva articoli commerciali Gelli (zurich.it) etichettati come “Portale istituzionale”.
`isOfficialRegionalPolicyDocument` richiedeva host istituzionale nel URL citato + attribuzione struttura.
