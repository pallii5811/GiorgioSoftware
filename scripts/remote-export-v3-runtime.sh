#!/usr/bin/env bash
# Export exact running v3 scripts + unit + checkpoint stats (no restart, no delete)
set -uo pipefail
OUT=/tmp/giorgio-v3-runtime-export
rm -rf "$OUT"
mkdir -p "$OUT/scripts" "$OUT/systemd" "$OUT/diag"

APP=/opt/leadsniper-revalidate/app
for f in \
  production-revalidate-sanita-v3.mjs \
  production-revalidate-sanita-worker.mjs \
  revalidate-checkpoint-v3.mjs \
  production-apply-revalidation.mjs \
  test-revalidation-v3.mjs
do
  if [ -f "$APP/scripts/$f" ]; then
    cp -a "$APP/scripts/$f" "$OUT/scripts/$f"
    sha256sum "$APP/scripts/$f" > "$OUT/scripts/$f.sha256"
  else
    echo "MISSING $f" >> "$OUT/MISSING.txt"
  fi
done

cp -a /etc/systemd/system/giorgio-revalidate.service "$OUT/systemd/giorgio-revalidate.service" 2>/dev/null || true
# sanitize unit: strip any secret-looking env values (keep names)
if [ -f "$OUT/systemd/giorgio-revalidate.service" ]; then
  sed -E 's/(PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL)=.*/\1=REDACTED/' \
    "$OUT/systemd/giorgio-revalidate.service" > "$OUT/systemd/giorgio-revalidate.service.sanitized" || true
fi

python3 - <<'PY'
import json, os, glob, hashlib, collections, re, datetime
from pathlib import Path

cp = json.loads(Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json").read_text())
res_dir = Path("/opt/leadsniper-revalidate/data/revalidation/results")
files = sorted(res_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
# skip temp pass files
files = [p for p in files if ".p1." not in p.name and ".p2." not in p.name and ".tmp" not in p.name]

rows = []
for p in files[:80]:
    try:
        rows.append(json.loads(p.read_text()))
    except Exception as e:
        rows.append({"id": p.stem, "parseError": str(e)})

# classify reason
CATS = [
    ("timeout_http", re.compile(r"timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|AbortError|LEAD_WALL_TIMEOUT|wall.?clock|run_wall", re.I)),
    ("dns", re.compile(r"ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS", re.I)),
    ("tls", re.compile(r"CERT_|SSL|TLS|UNABLE_TO_VERIFY|self.?signed|certificate", re.I)),
    ("http_403", re.compile(r"\b403\b|forbidden|WAF|cloudflare|access denied", re.I)),
    ("http_429", re.compile(r"\b429\b|rate.?limit|too many requests", re.I)),
    ("http_5xx", re.compile(r"\b50[0-9]\b|bad gateway|service unavailable|internal server", re.I)),
    ("playwright_crash", re.compile(r"playwright|chromium|browser.*crash|Target closed|Protocol error", re.I)),
    ("ocr_crash", re.compile(r"tesseract|OCR_|special-words|pdftoppm|OCR", re.I)),
    ("sqlite_busy", re.compile(r"SQLITE_BUSY|database is locked|SQLITE_LOCKED", re.I)),
    ("frontier_incomplete", re.compile(r"frontier|pending|incomplete|CRAWL_COMPLETE:false|retry_pending", re.I)),
    ("identity_unresolved", re.compile(r"identity|IDENTITY|MISMATCH|scope.?unresolved", re.I)),
    ("sitemap_unresolved", re.compile(r"sitemap", re.I)),
    ("pdf_unreadable", re.compile(r"pdf.*(unreadable|fail|timeout)|OCR_RENDERER|scanned", re.I)),
    ("worker_timeout", re.compile(r"LEAD_WALL_TIMEOUT|DUAL_HOT_PASS2_NO_OUTPUT|worker_no_output", re.I)),
]

def blob(r):
    parts = [
        str(r.get("reasonCode") or ""),
        str(r.get("error") or ""),
        str(r.get("processingState") or ""),
        str((r.get("pass1") or {}).get("error") or ""),
        str((r.get("pass2") or {}).get("error") or ""),
        str(r.get("fullEvidence") or "")[:800],
    ]
    return " | ".join(parts)

def classify(r):
    b = blob(r)
    for name, rx in CATS:
        if rx.search(b):
            return name
    if r.get("processingState") == "RETRY_PENDING":
        return "altro_retry"
    if r.get("processingState") == "TECHNICAL_BLOCKED":
        return "technical_blocked"
    if r.get("processingState") == "HOT_VERIFIED":
        return "terminal_hot"
    if str(r.get("processingState") or "").startswith("PUBLISHED"):
        return "terminal_pub"
    return "altro"

# last 20 attempts = newest results that are retry or have errors or recent
attempts = []
for r in rows:
    ps = r.get("processingState")
    if ps in ("RETRY_PENDING", "TECHNICAL_BLOCKED") or r.get("error") or (r.get("pass1") or {}).get("error"):
        attempts.append(r)
    if len(attempts) >= 40:
        break
if len(attempts) < 20:
    attempts = [r for r in rows if r.get("processingState") == "RETRY_PENDING"][:40]

counts = collections.Counter()
hosts = collections.defaultdict(set)
durations = collections.defaultdict(list)
attempts_n = collections.defaultdict(list)

for r in attempts:
    cat = classify(r)
    counts[cat] += 1
    # host from website
    w = r.get("website") or ""
    m = re.search(r"https?://([^/]+)", w)
    if m:
        hosts[cat].add(m.group(1).lower())
    wall = r.get("wallMs") or (r.get("pass1") or {}).get("wallMs")
    if wall:
        durations[cat].append(wall)
    att = (cp.get("attempts") or {}).get(r.get("id"))
    if att is not None:
        attempts_n[cat].append(att)

total = sum(counts.values()) or 1
report = {
    "generatedAt": datetime.datetime.now(datetime.UTC).isoformat(),
    "checkpoint": {
        "version": cp.get("version"),
        "terminal": len(cp.get("terminal") or {}),
        "retryQueue": len(cp.get("retryQueue") or {}),
        "inProgress": len(cp.get("inProgress") or {}),
        "stats": cp.get("stats"),
        "testedCodeSha": cp.get("testedCodeSha"),
        "updatedAt": cp.get("updatedAt"),
    },
    "attemptSampleSize": len(attempts),
    "categories": {},
}
for cat, n in counts.most_common():
    durs = durations.get(cat) or []
    report["categories"][cat] = {
        "count": n,
        "pct": round(100.0 * n / total, 1),
        "hosts": sorted(hosts.get(cat) or [])[:20],
        "wallMs_avg": int(sum(durs)/len(durs)) if durs else None,
        "attempts_avg": round(sum(attempts_n[cat])/len(attempts_n[cat]), 2) if attempts_n.get(cat) else None,
    }

# retry queue hygiene
rq = cp.get("retryQueue") or {}
hygiene = {"missing_nextRetryAt": 0, "missing_reason": 0, "due_now": 0, "future": 0, "duplicates": 0, "samples": []}
seen = set()
now = datetime.datetime.now(datetime.UTC)
for lid, meta in list(rq.items())[:50]:
    if lid in seen:
        hygiene["duplicates"] += 1
    seen.add(lid)
    if not meta.get("nextRetryAt"):
        hygiene["missing_nextRetryAt"] += 1
    if not (meta.get("lastReason") or meta.get("lastError")):
        hygiene["missing_reason"] += 1
    try:
        t = datetime.datetime.fromisoformat(meta["nextRetryAt"].replace("Z","+00:00"))
        if t <= now:
            hygiene["due_now"] += 1
        else:
            hygiene["future"] += 1
    except Exception:
        hygiene["missing_nextRetryAt"] += 1
    if len(hygiene["samples"]) < 10:
        hygiene["samples"].append({"id": lid, **{k: meta.get(k) for k in ("attempts","lastReason","lastError","nextRetryAt")}})

report["retryHygiene"] = hygiene

# terminal sample
term = []
for lid, meta in (cp.get("terminal") or {}).items():
    rp = res_dir / f"{lid}.json"
    row = json.loads(rp.read_text()) if rp.exists() else {}
    term.append({
        "id": lid,
        "processingState": meta.get("processingState"),
        "hasPass2": bool(row.get("pass2")),
        "dualDisagreement": row.get("dualDisagreement"),
        "reasonCode": row.get("reasonCode") or meta.get("reasonCode"),
    })
report["terminals"] = term

# load/mem snapshot
try:
    load = open("/proc/loadavg").read().split()[:3]
    mem = {}
    for line in open("/proc/meminfo"):
        if line.startswith(("MemAvailable","MemTotal","MemFree")):
            k,v,_ = line.split()[:3]
            mem[k] = int(v)
    report["host"] = {"loadavg": load, "mem_kb": mem}
except Exception as e:
    report["host"] = {"error": str(e)}

Path("/tmp/giorgio-v3-runtime-export/diag/retry-diagnosis.json").write_text(json.dumps(report, indent=2))
print(json.dumps({"export": "/tmp/giorgio-v3-runtime-export", "attempts": len(attempts), "cats": dict(counts), "terminal": len(cp.get("terminal") or {}), "retry": len(rq)}, indent=2))
PY

# pack
cd /tmp
tar -czf giorgio-v3-runtime-export.tgz -C /tmp giorgio-v3-runtime-export
ls -la /tmp/giorgio-v3-runtime-export.tgz
sha256sum /tmp/giorgio-v3-runtime-export.tgz
# prove service still running untouched
systemctl is-active giorgio-revalidate || true
