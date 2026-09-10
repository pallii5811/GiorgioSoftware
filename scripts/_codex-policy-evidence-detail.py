#!/usr/bin/env python3
import json
import re
import sqlite3
import sys


frontier_path = sys.argv[1]
connection = sqlite3.connect(f"file:{frontier_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute(
    """
    SELECT node.id AS nodeId, node.crawlRunId, node.canonicalUrl, node.resourceType, node.state,
           evidence.policyFound, evidence.policyCandidate,
           evidence.policySignalsJson, evidence.extractedAt,
           length(evidence.normalizedText) AS textLength,
           evidence.normalizedText
    FROM CrawlFrontierNode node
    LEFT JOIN CrawlNodeEvidence evidence ON evidence.nodeId = node.id
    WHERE node.resourceType = 'pdf'
       OR lower(coalesce(evidence.normalizedText, '')) LIKE '%posizione assicurativa%'
       OR lower(coalesce(evidence.normalizedText, '')) LIKE '%48480%'
       OR lower(coalesce(evidence.normalizedText, '')) LIKE '%rch00020000%'
    ORDER BY node.resourceType DESC, node.canonicalUrl, evidence.extractedAt DESC
    """
).fetchall()

needles = (
    "posizione assicurativa",
    "48480",
    "rch00020000",
    "sara assicurazioni",
    "validità polizza",
    "validita polizza",
)
result = []
for row in rows:
    item = dict(row)
    text = item.pop("normalizedText") or ""
    lowered = text.lower()
    offsets = [lowered.find(needle) for needle in needles]
    offsets = [offset for offset in offsets if offset >= 0]
    if offsets:
        start = max(0, min(offsets) - 500)
        item["context"] = re.sub(r"\s+", " ", text[start : start + 3000])
    else:
        item["context"] = re.sub(r"\s+", " ", text[:1200])
    result.append(item)

print(json.dumps(result, ensure_ascii=False, indent=2))
connection.close()
