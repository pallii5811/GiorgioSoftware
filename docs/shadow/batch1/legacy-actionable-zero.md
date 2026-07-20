# Legacy actionable = 0 (post-quarantine proof)

Query (shadow rerun DB, read-only):

```sql
SELECT COUNT(*) FROM Lead
WHERE type='HEALTHCARE'
  AND (evidence LIKE '%[V:HOT]%' OR evidence LIKE '%[V:PUB]%')
  AND evidence LIKE '%LEGACY:CURRENT%'
  AND evidence NOT LIKE '%LEGACY:RESCAN_REQUIRED%'
  AND evidence NOT LIKE '%LEGACY:LEGACY_UNVERIFIED%';
```

Result: **0** (see `docs/shadow/batch1/post-quarantine-check.json`).

Backend gate `isInActionableSalesQueue` with `ACTIONABLE_QUEUE_REQUIRE_CURRENT_EVIDENCE=true` excludes all `LEGACY:RESCAN_REQUIRED` healthcare leads.

Batch1 sanità metrics: `oldActionable=0`, `newActionable=0` on all 50 selected records.
