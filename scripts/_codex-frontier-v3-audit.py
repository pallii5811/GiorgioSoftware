import json
import os
import sqlite3
import sys

checkpoint_path = "/opt/leadsniper-revalidate/data/revalidation/checkpoint.json"
with open(checkpoint_path, encoding="utf-8") as handle:
    checkpoint = json.load(handle)

targets = list(checkpoint.get("inProgress", {}).items())
if len(sys.argv) > 1:
    targets = [
        (
            sys.argv[2] if len(sys.argv) > 2 else "manual",
            {"frontierPath": sys.argv[1], "manual": True},
        )
    ]

for lead_id, meta in targets:
    frontier_path = meta.get("frontierPath")
    print(json.dumps({"leadId": lead_id, "frontierPath": frontier_path, "meta": meta}))
    if not frontier_path or not os.path.exists(frontier_path):
        continue
    connection = sqlite3.connect(frontier_path)
    connection.row_factory = sqlite3.Row
    queries = {
        "states": "SELECT state, COUNT(*) AS count FROM CrawlFrontierNode GROUP BY state",
        "types": "SELECT resourceType, COUNT(*) AS count FROM CrawlFrontierNode GROUP BY resourceType",
        "relevance": "SELECT relevance, COUNT(*) AS count FROM CrawlFrontierNode GROUP BY relevance",
        "evidence": "SELECT COUNT(*) AS count FROM CrawlNodeEvidence",
        "rendered": (
            "SELECT COUNT(*) AS count FROM CrawlNodeEvidence "
            "WHERE playwrightSource = 'rendered'"
        ),
        "unresolvedCandidates": (
            "SELECT COUNT(*) AS count FROM CrawlNodeEvidence "
            "WHERE policyCandidate = 1 AND policyFound = 0"
        ),
    }
    output = {}
    for name, query in queries.items():
        try:
            output[name] = [dict(row) for row in connection.execute(query)]
        except Exception as error:
            output[name] = {"error": str(error)}
    try:
        row = connection.execute(
            "SELECT * FROM CrawlRun ORDER BY startedAt DESC LIMIT 1"
        ).fetchone()
        output["run"] = dict(row) if row else None
    except Exception as error:
        output["run"] = {"error": str(error)}
    try:
        blocked = connection.execute(
            """
            SELECT canonicalUrl, resourceType, discoverySource, lastError
            FROM CrawlFrontierNode
            WHERE state = 'TECHNICAL_BLOCKED'
            LIMIT 30
            """
        ).fetchall()
        output["blockedSample"] = [dict(row) for row in blocked]
    except Exception as error:
        output["blockedSample"] = {"error": str(error)}
    try:
        candidates = connection.execute(
            """
            SELECT canonicalUrl, normalizedText, policySignalsJson
            FROM CrawlNodeEvidence
            WHERE policyCandidate = 1 AND policyFound = 0
            LIMIT 10
            """
        ).fetchall()
        output["candidateSample"] = [
            {
                "canonicalUrl": row["canonicalUrl"],
                "text": (
                    lambda text: text[
                        max(
                            0,
                            min(
                                [
                                    pos
                                    for pos in (
                                        text.lower().find("polizz"),
                                        text.lower().find("assicur"),
                                        text.lower().find("responsabilit"),
                                        text.lower().find("gelli"),
                                    )
                                    if pos >= 0
                                ]
                                or [0]
                            )
                            - 300,
                        ) : min(
                            len(text),
                            max(
                                [
                                    pos
                                    for pos in (
                                        text.lower().find("polizz"),
                                        text.lower().find("assicur"),
                                        text.lower().find("responsabilit"),
                                        text.lower().find("gelli"),
                                    )
                                    if pos >= 0
                                ]
                                or [0]
                            )
                            + 1800,
                        )
                    ]
                )(row["normalizedText"] or ""),
                "signals": row["policySignalsJson"],
            }
            for row in candidates
        ]
    except Exception as error:
        output["candidateSample"] = {"error": str(error)}
    try:
        found = connection.execute(
            """
            SELECT canonicalUrl, normalizedText, policyText, policySignalsJson
            FROM CrawlNodeEvidence
            WHERE policyFound = 1
            ORDER BY extractedAt DESC
            LIMIT 10
            """
        ).fetchall()
        output["policyFoundSample"] = [
            {
                "canonicalUrl": row["canonicalUrl"],
                "text": (row["policyText"] or row["normalizedText"] or "")[:1200],
                "signals": row["policySignalsJson"],
            }
            for row in found
        ]
    except Exception as error:
        output["policyFoundSample"] = {"error": str(error)}
    try:
        missing = connection.execute(
            """
            SELECT n.canonicalUrl, n.resourceType, n.contentHash, n.lastError
            FROM CrawlFrontierNode n
            LEFT JOIN CrawlNodeEvidence e
              ON e.nodeId = n.id AND e.contentHash = n.contentHash
            WHERE n.state = 'COMPLETED'
              AND n.resourceType IN
                ('html','pdf','document','office','image','json','script','style','xml','text')
              AND e.nodeId IS NULL
            LIMIT 30
            """
        ).fetchall()
        output["missingEvidenceSample"] = [dict(row) for row in missing]
    except Exception as error:
        output["missingEvidenceSample"] = {"error": str(error)}
    try:
        unrendered = connection.execute(
            """
            SELECT n.canonicalUrl, n.contentHash, n.lastError,
                   e.playwrightSource
            FROM CrawlFrontierNode n
            LEFT JOIN CrawlNodeEvidence e
              ON e.nodeId = n.id AND e.contentHash = n.contentHash
            WHERE n.state = 'COMPLETED'
              AND n.resourceType = 'html'
              AND COALESCE(e.playwrightSource, '') != 'rendered'
            LIMIT 30
            """
        ).fetchall()
        output["unrenderedHtmlSample"] = [dict(row) for row in unrendered]
    except Exception as error:
        output["unrenderedHtmlSample"] = {"error": str(error)}
    print(json.dumps(output, ensure_ascii=False))
    connection.close()
