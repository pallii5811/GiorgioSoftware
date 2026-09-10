#!/usr/bin/env python3
import json
import os
import sqlite3
import sys


checkpoint_path, results_dir, database_path, *lead_ids = sys.argv[1:]
with open(checkpoint_path, "r", encoding="utf-8") as handle:
    checkpoint = json.load(handle)

connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row
table_names = {
    row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
}
lead_table = next((name for name in ("Lead", "leads", "lead") if name in table_names), None)

if lead_ids[:1] == ["--search"] and lead_table:
    needle = " ".join(lead_ids[1:])
    matches = connection.execute(
        f'SELECT id, companyName, city, region, website, evidence FROM "{lead_table}" '
        "WHERE lower(companyName) LIKE lower(?) ORDER BY companyName",
        (f"%{needle}%",),
    ).fetchall()
    print(json.dumps([dict(row) for row in matches], ensure_ascii=False, indent=2))
    connection.close()
    sys.exit(0)

for lead_id in lead_ids:
    retry_meta = checkpoint.get("retryQueue", {}).get(lead_id)
    terminal_meta = checkpoint.get("terminal", {}).get(lead_id)
    row = None
    if lead_table:
        row = connection.execute(
            f'SELECT * FROM "{lead_table}" WHERE id = ?', (lead_id,)
        ).fetchone()
    result_path = os.path.join(results_dir, f"{lead_id}.json")
    result = None
    if os.path.exists(result_path):
        with open(result_path, "r", encoding="utf-8") as handle:
            result = json.load(handle)

    output = {
        "id": lead_id,
        "lead": dict(row) if row else None,
        "retry": retry_meta,
        "terminal": terminal_meta,
        "resultPath": result_path if result is not None else None,
        "result": result,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))

connection.close()
