# Possible false negatives — Shadow Batch 1

**Run:** `shadow-batch1-20260718-rerun`  
**Mode:** `gate-reeval+light-probe` (no full exhaustive re-crawl; identity/completeness never invented)

## Sanità — degradations

| Transition | Count | Reproducible reason |
|------------|------:|---------------------|
| HOT → REVIEW | 28 | Legacy quarantine + identity `NOT_CHECKED` + crawl completeness fail-closed (`policyExhaustive=false`, sitemap `NOT_DISCOVERED`) |
| PUBLISHED → REVIEW | 8 | Same: terminal PUB blocked without verified identity/crawl re-certification |
| REVIEW → REVIEW | 14 | Unchanged under new gates |

Checklist applied to each demoted HOT/PUB:

1. **Missing proof?** Yes — Phase-2 requires CURRENT evidence + identity verified + crawl complete; snapshot markers are `LEGACY:RESCAN_REQUIRED` only.
2. **Crawler failed?** Light HEAD probe failed on some hosts (counted as technicalFailure); does not alone justify historical HOT.
3. **Site changed?** Not assumed; website field unchanged in this mode.
4. **Group domain?** Not auto-promoted without seat proof.
5. **Dynamic document?** Not re-fetched in this batch mode.
6. **Unread PDF?** Not re-OCR'd; OCR doubts only if historical evidence mentions OCR.
7. **Official source confirms?** Not re-verified live beyond HEAD probe.
8. **New-gate false negative?** **Possible** for structures that would certify HOT/PUB after full exhaustive crawl — that requires human review + future full rescan, not automatic promotion here.

**Recovery path:** full shadow crawl (S1-crawl) on the same IDs after human pack review; never lift `RESCAN_REQUIRED` without CURRENT markers.

## Gare — exclusures / demotions

| Change | Count | Reason |
|--------|------:|--------|
| old actionable → non-actionable (Campania) | 2 → 0 net actionable under new score | Recency/amount/contact gates; cauzione always ESTIMATE |
| Veneto remaining actionable (MEDIUM) | 2 | Only 2 Veneto tenders exist in snapshot |

No record excluded without reason. Missing 23 Veneto Gare slots are a **snapshot inventory gap**, not a gate false negative.

## Inventory blocker

`SNAPSHOT_HAS_ONLY_2_VENETO_TENDER_LEADS` — cannot fulfill 25 Gare Veneto from SHA `cfb9e878…`.
