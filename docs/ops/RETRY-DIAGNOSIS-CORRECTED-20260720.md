# Retry diagnosis (corrected) — 2026-07-20T20:41Z

Initial automated classifier over-attributed **ocr_crash** because stderr logs contain
`failed to load ./ita.special-words` even when that is non-fatal.

Manual review of 18 RETRY/TECH result JSON files (Hetzner shadow):

| Category | Count | % | Notes |
|---|---:|---:|---|
| pdf_unprocessed / crawl_incomplete | 10 | 55.6% | `N PDF non processati`, crawl non esaustivo |
| crawl_cap_url_or_time | 5 | 27.8% | cap URL / cap tempo / coda HTML non esaurita |
| sitemap_unresolved | 2 | 11.1% | ROBOTS_REFERENCED_FAILED / DISCOVERED_FAILED |
| identity_contamination | 1 | 5.6% | nome assente / sito errato |
| TECHNICAL_BLOCKED | 1 | — | Villa Maione (PDF incomplete → terminal tech) |

**Infrastructural false alarm:** OCR `ita.special-words` warnings present in process logs,
but `has_special_words_in_evidence=false` on all sampled results. Tessdata dir contains only
`ita.traineddata` + `eng.traineddata`.

**Conclusion:** dominant failure mode is **crawl budget / PDF queue incomplete** under
fail-closed HOT gates — not HTTP 403/429/DNS storms. Throughput fix must raise safe parallelism
and ensure PDF/OCR path is healthy without weakening HOT/PUBLISHED gates.
