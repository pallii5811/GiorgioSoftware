# Gare provenance — stop-ship 2026-07-19

## Rule

Ogni campo actionable deve provenire da OCDS/ANAC, documento ufficiale, enrichment verificato, o formula deterministica. Mai inventare per passare un gate.

## Campi e provenienza

| Campo | Fonte ammessa | Se manca |
|-------|---------------|----------|
| awardDate | evidence `Data aggiudicazione: YYYY-MM-DD`, ledger ANAC, enrichment | ENRICHMENT_PENDING / esclusione gate |
| officialSource | CIG + data verificata / `enrich.officialSource` | `false` → non actionable |
| relevance / category | `classifyProcurementCategory(object, cpv)` o DB | NON_CLASSIFICATO |
| insuranceNeed | pipeline ANAC (no force STRONGLY_INFERRED) | NOT_FOUND → fuori HIGH/VH |
| contactPath | phone/email/website reali | false |
| leadScore | `computeGareLeadScore(relevance, amount, …)` | 0 |
| revoked/deserted | solo se noti da fonte | non inventare false per sbloccare |

## Diff script recovery

Rimosso da `scripts/staging-runtime-recovery.mjs`:

- `awardDate: new Date()`
- `officialSource: true` hardcoded
- `relevance: "HIGH"` hardcoded
- `contactPath: true` hardcoded
- `insuranceNeed` forzato a `STRONGLY_INFERRED`
- categoria forzata `GARE_MEDIUM`
- score fisso `50`

## Gate

- date inventate = 0
- officialSource inventato = 0
- vincitore non verificato actionable = 0
- insurance need non supportato HIGH/VH = 0
- score fisso = 0
- categoria forzata = 0
