# Regression vs live commit ad38748

## Scope
Compare staging candidate HEAD against live application commit `ad38748ea59edd936b9c7def3a62fdd5ae9b4e2f`.

## Preserved
- Lead schema fields unchanged (no drop of website/policy*/evidence/tender*).
- Historical PUBLISHED tokens remain readable via `readVerdictToken`.
- UI components still import client-safe `verdict.ts` (encode/read/meta).
- Gare display maps undefined → NON_CLASSIFICATO (no GARE_undefined emission).
- Staging frontier is **additive** SQLite file — does not alter Lead rows on init.

## Additive (non-breaking)
- processingState / businessVerdict / validationStatus stamped into evidence text.
- Frontier/waterfall stores under data/staging/.
- Staging guard module.

## Critical regressions found in this harness
- None detected at schema/API-shape level.

## Residual product risks (not schema breaks)
- Full browser UX against a hosted staging URL was not available in this harness (local-only).
- Playwright/OCR proved via runtime module invocation (+ fixture fallback if sample did not trigger).
