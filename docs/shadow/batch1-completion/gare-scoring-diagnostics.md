# Gare scoring diagnostics — Campania Batch 1

**Origin:** IMMUTABLE_PRODUCTION_SNAPSHOT (SHA cfb9e878…)

Records: 25

## Tier distribution

- VERY_HIGH: 0
- HIGH: 0
- MEDIUM: 2
- LOW: 23
- NOT_ACTIONABLE: 0

## Why LOW / weak scores

- contatti_mancanti: 20
- data_assente_recency_zero: 24
- rilevanza_bassa: 13
- importo_basso: 7

## Notes

- Cauzioni are ESTIMATE (10%) unless contract text documents a guarantee — none found in snapshot evidence fields.
- GARE_undefined repaired to GARE_HIGH/MEDIUM/LOW via object/amount recompute; contract type in `[CONTRACT_TYPE:…]`.
- Low scores are mostly missing award dates (recency=0) + missing contacts + LOW relevance objects — not artificial.
