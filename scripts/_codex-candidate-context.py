#!/usr/bin/env python3
import re
import sqlite3
import sys

frontier_path = sys.argv[1]
url_fragment = sys.argv[2] if len(sys.argv) > 2 else ""
found_mode = len(sys.argv) > 3 and sys.argv[3].lower() == "found"
connection = sqlite3.connect(f"file:{frontier_path}?mode=ro", uri=True)
rows = connection.execute(
    f"""
    SELECT canonicalUrl, normalizedText, policyText, policySignalsJson
    FROM CrawlNodeEvidence
    WHERE {"policyFound = 1" if found_mode else "policyCandidate = 1 AND policyFound = 0"}
      AND canonicalUrl LIKE ?
    ORDER BY extractedAt DESC
    """,
    (f"%{url_fragment}%",),
).fetchall()

pattern = re.compile(
    r"polizz|assicur|compagn|massimal|franchig|premio|decorren|scaden|"
    r"contraente|quietanza|am\s*trust|generali|unipol|allianz|zurich|"
    r"axa|lloyd|hdi|qbe|chubb|aig|berkshire|relyens|sham|markel|beazley",
    re.IGNORECASE,
)
for url, normalized_text, policy_text, signals in rows:
    text = "\n".join(
        part for part in (policy_text or "", normalized_text or "") if part
    )
    print(f"URL={url}\nSIGNALS={signals}")
    seen = set()
    for match in pattern.finditer(text or ""):
        start = max(0, match.start() - 450)
        end = min(len(text), match.end() + 900)
        key = start // 300
        if key in seen:
            continue
        seen.add(key)
        print(f"\n--- {match.group(0)} @{match.start()} ---\n{text[start:end]}")
    print("\n" + "=" * 100)
connection.close()
