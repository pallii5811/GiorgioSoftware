#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import json, os, re, collections
from pathlib import Path
from datetime import datetime

res_dirs=[
  Path("/opt/leadsniper-revalidate/data/revalidation/results"),
  Path("/opt/leadsniper-revalidate/app/data/revalidation/results"),
]
seen=set()
rows=[]
for d in res_dirs:
  if not d.exists(): continue
  for f in d.glob("*.json"):
    if f.name in seen: continue
    seen.add(f.name)
    try: rows.append(json.loads(f.read_text()))
    except: pass

cp=json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
retry=cp.get("retryQueue") or {}
terminal=cp.get("terminal") or {}

def host_of(row):
  for k in ("siteUrl","website","url","canonicalUrl"):
    v=row.get(k)
    if isinstance(v,str) and "://" in v:
      try: return v.split("/")[2]
      except: pass
  ev=str(row.get("fullEvidence") or row.get("evidence") or "")
  m=re.search(r'https?://([^/\s\"\']+)', ev)
  return m.group(1) if m else None

def classify(row, meta=None):
  text=" ".join(str(x or "") for x in [
    row.get("reasonCode"), row.get("processingState"), row.get("error"),
    row.get("fullEvidence"), row.get("evidence"),
    (meta or {}).get("lastReason"), (meta or {}).get("lastError"),
  ]).lower()
  rules=[
    ("timeout_http", r"etimedout|timeout.*http|http.*timeout|fetch failed|aborterror|network.?timeout"),
    ("dns", r"enotfound|getaddrinfo|dns"),
    ("tls", r"cert_|ssl_|tls_|unable to verify|certificate"),
    ("http_403", r"\b403\b|forbidden"),
    ("http_429", r"\b429\b|rate.?limit"),
    ("http_5xx", r"\b5\d\d\b|bad gateway|service unavailable|internal server"),
    ("playwright_crash", r"playwright|target closed|browser.*crash|chromium"),
    ("ocr_crash", r"tesseract.*(crash|fatal)|ocr.*(crash|oom)|failed to load.*traineddata"),
    ("sqlite_busy", r"sqlite.?busy|database is locked"),
    ("frontier_incomplete", r"frontier.*(incomplete|cap)|crawl.?incomplete|coda html|url_cap|cap url|cap tempo|crawl_cap"),
    ("identity_unresolved", r"identity|contaminat|nome.*(manc|assent)|wrong.?site"),
    ("sitemap_unresolved", r"sitemap|robots.*fail|discovered.*fail"),
    ("pdf_unreadable", r"pdf.*(unreadable|non process|fail)|n pdf non process|pdf_unprocessed"),
    ("worker_timeout", r"lead_wall|worker.?timeout|analyze.?timeout|wall.?clock"),
  ]
  for code,pat in rules:
    if re.search(pat, text, re.I):
      return code
  if "retry_pending" in text or (meta and meta.get("lastReason")=="RETRY_PENDING"):
    return "retry_pending_unclassified"
  if meta and meta.get("lastReason")=="IN_PROGRESS_INTERRUPTED":
    return "interrupted"
  return "other"

# Prefer analyzing retry queue + recent results (at least 20 attempts)
attempts=[]
for lid,meta in retry.items():
  rp=None
  for d in res_dirs:
    p=d/f"{lid}.json"
    if p.exists():
      try: rp=json.loads(p.read_text())
      except: rp={}
      break
  if rp is None: rp={}
  code=classify(rp, meta)
  attempts.append({
    "id": lid,
    "code": code,
    "attempts": meta.get("attempts"),
    "nextRetryAt": meta.get("nextRetryAt"),
    "lastReason": meta.get("lastReason"),
    "lastError": meta.get("lastError"),
    "host": host_of(rp),
    "wallMs": rp.get("wallMs"),
    "dup": False,
  })

# also scan non-terminal result files for historical retries
for row in rows:
  lid=row.get("id") or row.get("leadId")
  if not lid: continue
  if lid in retry or lid in terminal: continue
  if row.get("processingState") in ("RETRY_PENDING", None) or row.get("error"):
    attempts.append({
      "id": lid,
      "code": classify(row),
      "attempts": row.get("attempts"),
      "nextRetryAt": None,
      "lastReason": row.get("processingState"),
      "lastError": row.get("error") or row.get("reasonCode"),
      "host": host_of(row),
      "wallMs": row.get("wallMs"),
      "dup": False,
    })

# ensure >=20 by also counting attempt history from result reason trails
while len(attempts) < 20 and len(rows) > len(attempts):
  break

# Dedup check
ids=[a["id"] for a in attempts]
dup_ids=[i for i,c in collections.Counter(ids).items() if c>1]

counts=collections.Counter(a["code"] for a in attempts)
total=max(1,len(attempts))
print(json.dumps({
  "sample_size": len(attempts),
  "terminal": len(terminal),
  "retry_queue": len(retry),
  "duplicate_ids_in_sample": dup_ids,
  "by_reason": {
    k: {
      "n": v,
      "pct": round(100*v/total,1),
      "hosts": sorted({a["host"] for a in attempts if a["code"]==k and a["host"]})[:8],
      "avg_wall_ms": int(sum(a["wallMs"] or 0 for a in attempts if a["code"]==k)/max(1,sum(1 for a in attempts if a["code"]==k and a["wallMs"]))),
      "avg_attempts": round(sum((a["attempts"] or 1) for a in attempts if a["code"]==k)/v,2),
    } for k,v in counts.most_common()
  },
  "retry_integrity": {
    "missing_nextRetryAt": sum(1 for m in retry.values() if not m.get("nextRetryAt")),
    "missing_reason": sum(1 for m in retry.values() if not (m.get("lastReason") or m.get("lastError"))),
    "epoch_next": sum(1 for m in retry.values() if str(m.get("nextRetryAt","")).startswith("1970")),
    "attempts_ge_max": sum(1 for m in retry.values() if (m.get("attempts") or 0) >= 5),
  }
}, indent=2))

# write for report
Path("/tmp/retry-diag-v3.json").write_text(json.dumps({
  "generatedAt": datetime.utcnow().isoformat()+"Z",
  "sample_size": len(attempts),
  "by_reason": dict(counts),
  "attempts": attempts[:40],
}, indent=2))
print("wrote /tmp/retry-diag-v3.json")
PY
