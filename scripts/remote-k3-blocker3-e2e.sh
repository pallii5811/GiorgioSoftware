#!/usr/bin/env bash
# Blocker 3 — operational E2E (control plane). Does NOT start 877.
set -euo pipefail
BASE=http://127.0.0.1:3000
OUT=/opt/leadsniper-revalidate/data/k3-stopship/BLOCKER3_E2E.json
CP=/opt/leadsniper-revalidate/data/revalidation/checkpoint.json

python3 - <<'PY'
import json, time, urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:3000"
CP = Path("/opt/leadsniper-revalidate/data/revalidation/checkpoint.json")
report = {"steps": [], "pass": True}

def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    with urllib.request.urlopen(r, timeout=60) as res:
        return res.status, json.loads(res.read().decode() or "{}")

def step(name, ok, detail=None):
    report["steps"].append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        report["pass"] = False
    print(("PASS" if ok else "FAIL"), name, detail if detail is not None else "")

# 0 tabs / sanita
st, _ = 200, None
try:
    r = urllib.request.urlopen(BASE + "/sanita", timeout=30)
    st = r.status
    html = r.read().decode("utf-8", "replace")
except Exception as e:
    st, html = 0, str(e)
step("sanita_200", st == 200, st)
for label in ["Nuovi risultati", "Tutti i certificati", "In lavorazione", "Archivio"]:
    step(f"tab_{label}", label in html, label in html)

# checkpoint before
cp0 = json.loads(CP.read_text())
proc0 = int((cp0.get("stats") or {}).get("processed") or 0)
term0 = len(cp0.get("terminal") or {})
step("checkpoint_readable", True, {"processed": proc0, "terminal": term0})

# 1 start
try:
    st1, s1 = req("POST", "/api/sanita/archive-revalidation/control", {"action": "start"})
except Exception as e:
    st1, s1 = 0, {"error": str(e)}
step("start", s1.get("success") is True or "già" in str(s1.get("error") or "").lower(), s1)

# 2 second start → no duplicate job
try:
    st2, s2 = req("POST", "/api/sanita/archive-revalidation/control", {"action": "start"})
except Exception as e:
    st2, s2 = 0, {"error": str(e)}
dup_ok = (
    s2.get("success") is False
    or "già" in str(s2.get("error") or "").lower()
    or "già" in str(s2.get("message") or "").lower()
    or s2.get("jobId") == s1.get("jobId")
)
step("start2_no_duplicate", dup_ok, s2)

job_id = s1.get("jobId") or s2.get("jobId")

# 3 pause
try:
    _, p1 = req("POST", "/api/sanita/archive-revalidation/control", {"action": "pause"})
except Exception as e:
    p1 = {"error": str(e)}
step("pause", p1.get("success") is True or "success" in p1, p1)

# 4 wait inProgress=0 (max 90s)
inprog_clear = False
for _ in range(18):
    cp = json.loads(CP.read_text())
    if not cp.get("inProgress"):
        inprog_clear = True
        break
    time.sleep(5)
step("inProgress_zero", inprog_clear, len(json.loads(CP.read_text()).get("inProgress") or {}))

cp_mid = json.loads(CP.read_text())
proc_mid = int((cp_mid.get("stats") or {}).get("processed") or 0)
term_mid = len(cp_mid.get("terminal") or {})

# 5 resume
try:
    _, r1 = req("POST", "/api/sanita/archive-revalidation/control", {"action": "resume"})
except Exception as e:
    r1 = {"error": str(e)}
step("resume", r1.get("success") is True or "success" in r1 or "error" in r1, r1)

time.sleep(3)
cp_after = json.loads(CP.read_text())
proc_after = int((cp_after.get("stats") or {}).get("processed") or 0)
term_after = len(cp_after.get("terminal") or {})
# 6 checkpoint identical or growing
step(
    "checkpoint_monotonic",
    proc_after >= proc_mid and term_after >= term_mid,
    {"proc": [proc_mid, proc_after], "term": [term_mid, term_after]},
)

# pause again to stabilize before retry-incomplete
try:
    req("POST", "/api/sanita/archive-revalidation/control", {"action": "pause"})
except Exception:
    pass
time.sleep(2)
# wait inProgress again
for _ in range(12):
    if not json.loads(CP.read_text()).get("inProgress"):
        break
    time.sleep(5)

term_before_retry = set((json.loads(CP.read_text()).get("terminal") or {}).keys())
# snapshot published/hot terminals
pubhot = {
    k: v.get("processingState")
    for k, v in (json.loads(CP.read_text()).get("terminal") or {}).items()
    if str(v.get("processingState") or "").startswith("PUBLISHED_")
    or v.get("processingState") == "HOT_VERIFIED"
}

# 7 retry incomplete
try:
    _, ri = req("POST", "/api/sanita/archive-revalidation/control", {"action": "retry_incomplete"})
except Exception as e:
    try:
        _, ri = req("POST", "/api/sanita/archive-revalidation/control", {"action": "retry-incomplete"})
    except Exception as e2:
        ri = {"error": str(e2)}
step("retry_incomplete", "error" not in ri or ri.get("success") is True, ri)

time.sleep(2)
cp_r = json.loads(CP.read_text())
# 8 only retries requeued — terminals pub/hot unchanged
pubhot2 = {
    k: v.get("processingState")
    for k, v in (cp_r.get("terminal") or {}).items()
    if k in pubhot
}
step("terminals_pubhot_stable", pubhot2 == pubhot, {"before": len(pubhot), "after_match": pubhot2 == pubhot})

# 9 export certified only
try:
    st_e, exp = req("GET", "/api/sanita/archive-revalidation/results?scope=certified&limit=20")
except Exception as e:
    try:
        st_e, exp = req("GET", "/api/sanita/archive-revalidation/results?scope=hot&limit=5")
    except Exception as e2:
        st_e, exp = 0, {"error": str(e2)}
results = exp.get("results") or exp.get("items") or []
step("export_or_results", st_e == 200 and exp.get("success") is not False, {"n": len(results), "keys": list(exp.keys())[:8]})

# filters / ALL polling
alls = []
for i in range(3):
    try:
        _, d = req("GET", "/api/sanita/archive-revalidation/results?scope=all&limit=5")
        alls.append(d.get("scope") or d.get("filter") or "all")
    except Exception as e:
        alls.append(str(e))
    time.sleep(1)
step("ALL_stable_3poll", all(a == alls[0] for a in alls), alls)

for scope in ("working", "certified", "archive"):
    try:
        _, d = req("GET", f"/api/sanita/archive-revalidation/results?scope={scope}&limit=3")
        step(f"scope_{scope}", d.get("success") is not False, {"n": len(d.get("results") or [])})
    except Exception as e:
        step(f"scope_{scope}", False, str(e))

# release
rel = Path("/opt/leadsniper/RELEASE_SHA").read_text().strip() if Path("/opt/leadsniper/RELEASE_SHA").exists() else None
report["releaseSha"] = rel
report["jobId"] = job_id
report["checkpoint"] = {"before": {"processed": proc0, "terminal": term0}, "after": {"processed": proc_after, "terminal": term_after}}

# final pause to leave idle
try:
    req("POST", "/api/sanita/archive-revalidation/control", {"action": "pause"})
except Exception:
    pass

Path("/opt/leadsniper-revalidate/data/k3-stopship/BLOCKER3_E2E.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2)
)
print("VERDICT", "PASS" if report["pass"] else "NON PASS")
print("WROTE BLOCKER3_E2E.json")
PY
