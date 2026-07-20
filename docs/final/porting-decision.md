# Porting decision — quality → final-production-grade

**Live application commit (manifest):** `ad38748ea59edd936b9c7def3a62fdd5ae9b4e2f`  
**Quality HEAD at branch cut:** `b311e99feeaf351b39c319e8f596374390a9ab56`  
**Final branch:** `cto/final-production-grade-20260719`  
**Base:** quality HEAD (descendant of live) + REWORK of fail-closed-over-REVIEW behaviour

## Commits / surfaces

| Item | Decision | Motivation | Safety test |
|------|----------|------------|-------------|
| `can-emit-hot.ts` + `atomic-verdict.ts` | **KEEP** | Prevents false HOT | `test:hot-proof` |
| `discovery-gate.ts` (Tavily≠PUB) | **KEEP** | Blocks discovery terminal PUB | `test:published-defense` |
| `published-subtype.ts` | **REWORK** | Labels OK; must pair with validationStatus | characterization + UX |
| `relevanceCategory` → NON_CLASSIFICATO | **KEEP** | Stops GARE_undefined / invented GARE_LOW | `test:gare-actionable` |
| `actionable-gate.ts` | **KEEP** + extend ENRICHMENT_PENDING | Correct exclusions | gare tests |
| Shadow runners / batch1 packs / e2e TECHNICAL flood | **DROP** from runtime path | Caused 99% REVIEW/TECHNICAL without preserving business PUB | n/a (docs only) |
| `finalizeVerdict` HOT→REVIEW on incomplete | **REWORK** | Keep gate but route tech to RETRY_PENDING / preserve BV | state-machine tests |
| Policy-verify obsolete→PUBLISHED | **KEEP** | Expired ≠ absence HOT | characterization |
| Closure human-review HTML dumps | **DROP** from engine; **KEEP** as docs artifact | Not product code | n/a |
| `resolution-waterfall.ts` | **REWORK** | Wire real steps / no stub PASS | waterfall + state-machine |
| Baseline ID pack | **KEEP** | Regression corpus IDs | characterization fixtures (versioned) |
| `crawl-frontier-ledger.ts` | **KEEP** (partial) | Blocks HOT on open frontier; **not yet DB-persistent** | `test:hot-proof` |
| `entity-fingerprint.ts` | **KEEP** | Attribution rule strong/medium | characterization + canEmitPublished |
| `test:bypass-audit` | **KEEP** | Static gate that scan persist uses gateway | bypass-audit |
| Obsolete→HOT in scan-engine | **DROP** (fixed) | Expired must stay PUBLISHED | characterization + bypass-audit |

## Principle

Technical failure updates **validationStatus** / **RETRY_PENDING**.  
It must **not** erase a historically proven **businessVerdict** PUBLISHED.

## Ready gate

See `docs/final/status.md` — current verdetto **NOT READY** until frontier persistence, shadow sample, and gare enrichment loop close.
