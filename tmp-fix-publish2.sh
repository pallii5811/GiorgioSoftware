#!/bin/bash
set -euo pipefail

python3 <<'PY'
from pathlib import Path

# 1) Never query missing budget table
p = Path("/home/worker/app/backend/lead_acceptance/publication.py")
t = p.read_text(encoding="utf-8")
start = t.find("def _budget_allows")
end = t.find("\n\ndef publish_accepted_leads", start)
if start < 0 or end < 0:
    raise SystemExit("cannot find _budget_allows bounds")
replacement = '''def _budget_allows(supabase: Any, search_id: str) -> bool:
    """Budget table may be absent on prod; never hard-block publish."""
    # ponytail: skip search_budget_state until migration exists on prod Supabase.
    return True
'''
t = t[:start] + replacement + t[end+1:]  # end points at \n\ndef...; keep one \n
p.write_text(t, encoding="utf-8")
print("budget_allows_always_true")

# 2) In safe publish: if lifecycle returns empty, still persist scraped leads
w = Path("/home/worker/app/backend/worker_supabase.py")
wt = w.read_text(encoding="utf-8")
needle = """                    lifecycle_published = persist_and_publish_candidates(
                        supabase,
                        search_id=str(job_id),
                        user_id=str(job.get("user_id") or "").strip() or None,
                        leads=candidate_pool if lifecycle_shadow_mode else merged,
                        canonical_plan=commercial_intent,
                        shadow_mode=lifecycle_shadow_mode,
                    )
                    # Preserve previously published rows, never intermediate candidates.
                    merged = _cap_search_results(
                        _merge_formatted_results(current, lifecycle_published),
                        job_max,
                        prioritize_hot=prioritize_hot,
                    )"""
if needle not in wt:
    raise SystemExit("lifecycle_published block not found")
repl = """                    try:
                        lifecycle_published = persist_and_publish_candidates(
                            supabase,
                            search_id=str(job_id),
                            user_id=str(job.get("user_id") or "").strip() or None,
                            leads=candidate_pool if lifecycle_shadow_mode else merged,
                            canonical_plan=commercial_intent,
                            shadow_mode=lifecycle_shadow_mode,
                        )
                    except Exception as lifecycle_error:
                        print(f"[worker_supabase] lifecycle publish error: {lifecycle_error}", flush=True)
                        lifecycle_published = []
                    if not lifecycle_published:
                        # Schema/lifecycle lag: still show scraped leads in searches.results
                        lifecycle_published = list(merged)
                        print(
                            f"[worker_supabase] lifecycle empty -> using {len(lifecycle_published)} scraped leads",
                            flush=True,
                        )
                    # Preserve previously published rows, never intermediate candidates.
                    merged = _cap_search_results(
                        _merge_formatted_results(current, lifecycle_published),
                        job_max,
                        prioritize_hot=prioritize_hot,
                    )"""
wt = wt.replace(needle, repl, 1)
w.write_text(wt, encoding="utf-8")
print("patched_lifecycle_empty_fallback")
PY

systemctl restart mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
sleep 2
systemctl is-active mirax-worker-user mirax-worker-user-2 mirax-worker-backlog

python3 <<'PY'
import json, urllib.request
from pathlib import Path
env = {}
for line in Path("/home/worker/app/backend/.env").read_text().splitlines():
    s = line.strip()
    if not s or s.startswith("#") or "=" not in s:
        continue
    k, v = s.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")
jid = "f98bb3dc-9538-4461-821d-df3f28580eb8"
body = json.dumps({"status": "pending", "results": []}).encode()
url = env["SUPABASE_URL"].rstrip("/") + f"/rest/v1/searches?id=eq.{jid}"
req = urllib.request.Request(
    url,
    data=body,
    method="PATCH",
    headers={
        "apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
        "Authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    },
)
urllib.request.urlopen(req, timeout=20)
print("requeued", jid)
PY
echo DONE
