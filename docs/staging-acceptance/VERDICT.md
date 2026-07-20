# Staging acceptance — FINAL PRODUCT CLOSURE (progress)

**Branch:** `cto/final-production-grade-20260719`  
**HEAD at run:** see `analyzelead-acceptance.json` → `head`  
**Verdict:** **STAGING ACCEPTANCE FAILED** (HOT / browser / Gare / full suite pending)

## Gates

| Gate | Result | Evidence |
|------|--------|----------|
| Sitemap pipeline real | PASS (unit 12/12) | `discoverAndProcessSitemaps` |
| Playwright adaptive default | PASS (unit 6/6) | `enablePlaywright="adaptive"` |
| Document fingerprint extracted | PASS (unit 12/12) | `extractDocumentEntityFingerprint` |
| OCR contract + preflight | PASS | `preflight:ocr` exit 0; `test:ocr-contract` 9/9 |
| Exact gold 4/4 | **PASS 4/4** | `analyzelead-acceptance.json` — Clotilde `PUBLISHED_EXPIRED` |
| analyzeLead real path (published) | PASS | `scripts/staging-analyzelead-acceptance.mjs` |
| false CURRENT / false HOT (published) | PASS 0/0 | Antoniano/Minerva/Villa not CURRENT_VERIFIED |
| npm test | PASS | suite completa exit 0 |
| Canonicalize path case | PASS | PDF path case preserved |

## Published gold (verified 2026-07-20)

| Lead | expected | result |
|------|----------|--------|
| Fondazione Clotilde | PUBLISHED_EXPIRED | `PUBLISHED_EXPIRED` / `CURRENT_VERIFIED` |
| Fondazione Istituto Antoniano | NOT_CURRENT_VERIFIED | `REVIEW_HUMAN` / `REVALIDATION_PENDING` |
| Clinica Minerva | NOT_CURRENT_VERIFIED | `REVIEW_HUMAN` / `CONFLICT_FOUND` |
| Villa Del Sole | NOT_CURRENT_VERIFIED | `REVIEW_HUMAN` / `REVALIDATION_PENDING` |

## Remaining (not yet verified end-to-end for PRC)

- HOT complete≥1 via real `analyzeLead` (Heidy, Progenia, Simamed, Marigold)
- Browser semantic parity re-run on committed HEAD
- Gare 25+25 provenance
- Full certification matrix on clean worktree (`npm ci` + all gates)

## Do not claim

PRODUCTION RELEASE CANDIDATE — HUMAN SIGN-OFF REQUIRED
