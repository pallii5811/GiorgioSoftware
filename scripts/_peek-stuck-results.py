#!/usr/bin/env python3
"""Peek key fields from stuck sample result JSONs."""
import json
from pathlib import Path

IDS = [
  "cmql4qrim0014c9w7cyzl5p2c",  # Cardiologia FRONTIER_INCOMPLETE
  "cmqma47ng000c9g5cw85q6myn",  # La Quiete
  "cmql46eia000ac9w78xh0rxdl",  # Nuova Alba
  "cmqkld5sa00af108epednu868",  # Cardiomed SITEMAP
  "cmqkld5s3009z108e1yj01zqy",  # Clinic Center PDF
  "cmqkld5s0009u108eghihpoxi",  # Magnolie ANALYZE
  "cmqklex5g00b6108ejom1shk0",  # Malzoni Radio
  "cmqkld5rx009p108edj6t9krw",  # Pineta RETRY_PENDING
  "cmqkld5t000ao108esg4xv094",  # ICM
  "cmqma7vmf000v9g5cz4zmmmy9",  # Elite
]
KEYS = [
  "processingState","reasonCode","error","newVerdict","businessVerdict",
  "crawlComplete","frontierIncomplete","urlCapReached","timeCapReached",
  "pagesFetched","htmlFetched","pdfQueued","pdfProcessed","pdfFailed",
  "ocrErrors","wallMs","durationMs","companyName","websiteUrl","sourceUrl",
  "message","detail","lastError","sitemapResolved","pendingNodes","completedNodes",
  "validationStatus","fullEvidence"
]

def slim(obj, depth=0):
  if depth > 2: return type(obj).__name__
  if isinstance(obj, dict):
    out = {}
    for k,v in obj.items():
      if k in KEYS or k.endswith("Count") or k.endswith("Ms") or k in ("runId","frontierPath","strategy"):
        if isinstance(v, (dict, list)) and k == "fullEvidence":
          out[k] = {"keys": list(v.keys())[:20] if isinstance(v, dict) else f"list:{len(v)}"}
        else:
          out[k] = slim(v, depth+1) if isinstance(v, (dict, list)) else v
    # always include top-level scalar-ish extras that look useful
    for k,v in obj.items():
      if k not in out and isinstance(v, (str, int, float, bool, type(None))) and k.lower().find("pdf")>=0:
        out[k] = v
      if k not in out and isinstance(v, (str, int, float, bool, type(None))) and any(x in k.lower() for x in ("crawl","frontier","cap","sitemap","ocr","wall","reason","error","verdict","state")):
        out[k] = v
    return out
  if isinstance(obj, list):
    return [slim(x, depth+1) for x in obj[:5]]
  return obj

base = Path("/opt/leadsniper-revalidate/data/revalidation/results")
for lid in IDS:
  p = base / f"{lid}.json"
  if not p.exists():
    print(lid, "MISSING")
    continue
  row = json.loads(p.read_text())
  print("====", lid, (row.get("companyName") or "")[:40])
  print(json.dumps(slim(row), ensure_ascii=False, indent=2)[:2000])
