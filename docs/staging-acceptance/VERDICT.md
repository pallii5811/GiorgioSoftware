# Staging acceptance — FINAL PRODUCT CLOSURE (progress)

**Branch:** `cto/final-production-grade-20260719`  
**HEAD at run:** see `analyzelead-acceptance.json`  
**Verdict:** **STAGING ACCEPTANCE FAILED**

## Gates

| Gate | Result | Evidence |
|------|--------|----------|
| Sitemap pipeline real | PASS (unit 12/12) | `discoverAndProcessSitemaps`; Clotilde `DISCOVERED_COMPLETE` / Minerva `ROBOTS_REFERENCED_COMPLETE` |
| Playwright adaptive default | PASS (unit 6/6) | `enablePlaywright="adaptive"` in `lead-crawl-runtime` |
| Document fingerprint extracted | PASS (unit 12/12) | `extractDocumentEntityFingerprint` — no lead-field copy |
| Exact gold 4/4 | **FAIL 3/4** | Antoniano/Minerva/Villa → not CURRENT; **Clotilde** stuck REVIEW (scanned PDF OCR unreadable without poppler) |
| analyzeLead real path | PASS | `scripts/staging-analyzelead-acceptance.mjs` |
| false CURRENT / false HOT | PASS 0/0 | after VS fix (REVIEW no longer stamps `CURRENT_VERIFIED`) |
| npm ci full | PASS | clean worktree + `NODE_EXTRA_CA_CERTS` (Windows Root export) + sqlite `DATABASE_URL` for prisma-smart |
| Canonicalize path case | PASS | was lowercasing PDF paths → 404 on Clotilde Assicurazione PDF |

## Remaining blocker (honest)

Fondazione Clotilde PDF is 38-page **scanned** (`Assicurazione-Rischi-Avversi-…pdf`).  
Digital extract is page markers only. Without `pdftoppm` (poppler), OCR falls back to JPEG carving → garbage text → `policyFound=false` → cannot emit `PUBLISHED_EXPIRED`.

**Not verified end-to-end for PRC:** HOT complete≥1, browser semantic re-run, Gare 25+25, full suite on clean HEAD commit.

## Do not claim

PRODUCTION RELEASE CANDIDATE — HUMAN SIGN-OFF REQUIRED
