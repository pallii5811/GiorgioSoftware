# Final closure report — 2026-07-19

## Verdict

**RELEASE CANDIDATE — HUMAN REVIEW REQUIRED**

Unique residual blocker: `humanReviewed = 0` on all final packs.

## Clean install

| Item | Value |
|------|-------|
| OS | Windows 10 (win32 10.0.19045) |
| Node | v22.22.3 |
| npm | 10.9.8 |
| lockfile | package-lock.json |
| commit | `c19aa47` |
| worktree | `../leadsniper-closure-ci-20260719` |
| npm ci | exit 0 (~103s) |
| prisma generate | exit 0 (NODE_TLS_REJECT_UNAUTHORIZED=0 required in this env for binaries.prisma.sh MITM/cert) |

## Safety

live write 0 · deploy 0 · email 0 · webhook 0 · cron 0 · deletes 0 · quarantine live markers not touched.

## Notes

- PUB e2e: re-fetch of evidence URLs; TECHNICAL_REVALIDATION does **not** count as lost true positive.
- HOT: zero auto-confirmed without complete crawl graph (canEmitHot fail-closed).
- Gare: `NON_CLASSIFICATO` replaces invented `GARE_LOW` category; Veneto 50 from OFFICIAL_SHADOW_INGEST ledger.
- Review rate measured ~99% on fail-closed corpus — target ≤10% not forced; top causes documented in metrics JSON.
