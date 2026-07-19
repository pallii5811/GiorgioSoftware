# PUBLISHED live baseline v1

**Frozen from:** immutable snapshot SHA `cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab`  
**Count:** 120  
**Frozen at:** 2026-07-19T10:12:07.627700+00:00

## Classification (heuristic from snapshot fields — human review still required)

| Class | Count |
|-------|------:|
| `CONFIRMED_DATE_UNKNOWN` | 60 |
| `CONFIRMED_EXPIRED` | 24 |
| `CONFIRMED_INCOMPLETE_PUBLICATION` | 8 |
| `CONFIRMED_VALID` | 6 |
| `TECHNICAL_REVALIDATION_REQUIRED` | 22 |

## Rules

- This pack is the **positive regression baseline**.
- Do not degrade a CONFIRMED_* record solely because a new crawler is incomplete.
- Full PII JSONL is gitignored: `data/baseline/published-live-v1.jsonl`
- ID list (no PII beyond opaque ids): `docs/baseline/published-live-v1-ids.json`

## Gate

- True positives lost by new engine: **must be 0**
- New PUBLISHED without valid proof: **must be 0**
