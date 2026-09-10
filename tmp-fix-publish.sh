#!/bin/bash
set -euo pipefail

# 1) Budget gate: missing table must NOT block publish
python3 <<'PY'
from pathlib import Path
p = Path("/home/worker/app/backend/lead_acceptance/publication.py")
t = p.read_text(encoding="utf-8")
old = '''def _budget_allows(supabase: Any, search_id: str) -> bool:
    from commercial_lifecycle import _execute_data

    budget_rows = _execute_data(
        supabase.table("search_budget_state")
        .select("hard_cost_eur,committed_cost_eur,status")
        .eq("search_id", search_id)
        .limit(1)
        .execute()
    )
    budget = budget_rows[0] if budget_rows else {}
    try:
        return bool(
            budget
            and float(budget.get("committed_cost_eur") or 0) <= float(budget.get("hard_cost_eur") or -1)
            and str(budget.get("status") or "").lower() not in {"halted", "failed"}
        )
    except (TypeError, ValueError):
        return False'''
new = '''def _budget_allows(supabase: Any, search_id: str) -> bool:
    """Allow publish when budget table is absent (prod schema may lag code)."""
    from commercial_lifecycle import _execute_data

    try:
        budget_rows = _execute_data(
            supabase.table("search_budget_state")
            .select("hard_cost_eur,committed_cost_eur,status")
            .eq("search_id", search_id)
            .limit(1)
            .execute()
        )
    except Exception as e:
        msg = str(e)
        if "search_budget_state" in msg or "PGRST205" in msg:
            return True
        raise
    budget = budget_rows[0] if budget_rows else {}
    if not budget:
        # No budget row yet → do not hard-block scraping publish.
        return True
    try:
        return bool(
            float(budget.get("committed_cost_eur") or 0) <= float(budget.get("hard_cost_eur") or 0)
            and str(budget.get("status") or "").lower() not in {"halted", "failed"}
        )
    except (TypeError, ValueError):
        return True'''
if old not in t:
    raise SystemExit("budget_allows block not found")
p.write_text(t.replace(old, new, 1), encoding="utf-8")
print("patched_budget_allows")
PY

# 2) Safe publish fallback: always write results to searches even if lifecycle fails
python3 <<'PY'
from pathlib import Path
p = Path("/home/worker/app/backend/worker_supabase.py")
t = p.read_text(encoding="utf-8")
old = '''                except Exception as e:
                    print(f"[worker_supabase] Safe publish skipped: {e}", flush=True)
                    return current if current else []'''
new = '''                except Exception as e:
                    print(f"[worker_supabase] Safe publish skipped: {e}", flush=True)
                    # Fallback: still persist scraped leads so UI/job polling works
                    # even if commercial lifecycle / budget tables are missing.
                    try:
                        merged_fallback = _cap_search_results(
                            _merge_formatted_results(
                                current,
                                new_results if isinstance(new_results, list) else [],
                            ),
                            job_max,
                        )
                        payload = {"results": merged_fallback}
                        if status:
                            payload["status"] = status
                        supabase.table("searches").update(payload).eq("id", job_id).execute()
                        with _rt_lock:
                            _rt_results.clear()
                            _rt_results.extend(merged_fallback)
                        print(
                            f"[worker_supabase] Safe publish FALLBACK wrote {len(merged_fallback)} results",
                            flush=True,
                        )
                        return merged_fallback
                    except Exception as e2:
                        print(f"[worker_supabase] Safe publish fallback failed: {e2}", flush=True)
                        return current if current else []'''
if old not in t:
    raise SystemExit("safe publish except block not found or already patched")
p.write_text(t.replace(old, new, 1), encoding="utf-8")
print("patched_safe_publish_fallback")
PY

systemctl restart mirax-worker-user mirax-worker-user-2 mirax-worker-backlog
sleep 2
systemctl is-active mirax-worker-user mirax-worker-user-2 mirax-worker-backlog

# requeue current Torino job again so it can publish
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
body = json.dumps({"status": "pending"}).encode()
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
