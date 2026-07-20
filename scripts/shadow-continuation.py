#!/usr/bin/env python3
"""
Shadow continuation: clean restore from immutable backup + quarantine on NEW shadow DB.
Never touches live. Never overwrites the immutable backup.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / "data/shadow/db/giorgio-live-backup-20260718.db"
EXPECTED_SHA = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"
RERUN_DB = ROOT / "data/shadow/db/giorgio-shadow-20260718-rerun.db"
OLD_SHADOW = ROOT / "data/shadow/db/giorgio-shadow-20260718.db"
LOCK = ROOT / "data/shadow/db/.shadow-worker.lock"
HEARTBEAT = ROOT / "data/shadow/db/.shadow-heartbeat"
CHECKPOINT = ROOT / "data/shadow/db/.shadow-checkpoint.json"
# ponytail: hard wall-clock for heavy local shadow jobs; raise via SHADOW_TIMEOUT_SEC if needed
DEFAULT_TIMEOUT_SEC = int(os.environ.get("SHADOW_TIMEOUT_SEC", "1800"))

EV_RE = re.compile(
    r"\[EV_V:(\d+)\s+VD_V:(\d+)\s+LEGACY:(CURRENT|LEGACY_UNVERIFIED|RESCAN_REQUIRED)\]",
    re.I,
)
VERDICT_RE = re.compile(r"\[V:(HOT|PUB|REV)\]", re.I)
HIST_RE = re.compile(r"\[SHADOW_HIST_VERDICT:")
CURRENT_EV = 2
CURRENT_VD = 2


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def die(msg: str, code: int = 78) -> None:
    print(f"SHADOW GUARD REFUSED: {msg}", file=sys.stderr)
    sys.exit(code)


def assert_env() -> None:
    if os.environ.get("SHADOW_MODE") not in ("true", "1"):
        die("SHADOW_MODE must be true")
    if not os.environ.get("SHADOW_DATABASE_ID"):
        die("SHADOW_DATABASE_ID required")
    for flag in (
        "DISABLE_EMAILS",
        "DISABLE_WEBHOOKS",
        "DISABLE_CUSTOMER_NOTIFICATIONS",
        "DISABLE_PUBLIC_QUEUE_PUBLISH",
        "DISABLE_PRODUCTION_CRON",
    ):
        if os.environ.get(flag) not in ("true", "1"):
            die(f"{flag} must be true")


def acquire_lock(run_id: str) -> None:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    if LOCK.exists():
        try:
            meta = json.loads(LOCK.read_text(encoding="utf-8"))
            pid = meta.get("pid")
            if pid and _pid_alive(pid):
                die(f"another shadow worker active pid={pid} run={meta.get('runId')}")
        except Exception:
            die("stale/corrupt shadow lock — remove manually after inspection")
    LOCK.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "runId": run_id,
                "startedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    HEARTBEAT.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")


def release_lock() -> None:
    try:
        LOCK.unlink(missing_ok=True)
    except TypeError:
        if LOCK.exists():
            LOCK.unlink()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
    except Exception:
        return False


def heartbeat() -> None:
    HEARTBEAT.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")


def checkpoint(run_id: str, step: str, extra: dict | None = None) -> None:
    payload = {
        "runId": run_id,
        "step": step,
        "at": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
    }
    if extra:
        payload.update(extra)
    CHECKPOINT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    heartbeat()


def _on_signal(signum: int, _frame) -> None:
    name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
    try:
        CHECKPOINT.write_text(
            json.dumps(
                {
                    "interruptedBy": name,
                    "at": datetime.now(timezone.utc).isoformat(),
                    "pid": os.getpid(),
                    "note": "safe to resume after inspecting lock/checkpoint; do not touch live",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass
    release_lock()
    print(f"SHADOW INTERRUPTED by {name} — lock released; resume from checkpoint", file=sys.stderr)
    sys.exit(130 if signum == getattr(signal, "SIGINT", 2) else 143)


def install_signal_handlers() -> None:
    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is not None:
            signal.signal(sig, _on_signal)


def enforce_timeout(timeout_sec: int) -> None:
    """Fail closed if a heavy shadow step exceeds wall clock (Unix SIGALRM; no-op on Windows)."""
    if not hasattr(signal, "SIGALRM"):
        return

    def _timeout(_s, _f):
        release_lock()
        die(f"shadow worker timeout after {timeout_sec}s", code=124)

    signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(timeout_sec)


def clear_timeout() -> None:
    if hasattr(signal, "SIGALRM"):
        signal.alarm(0)


def verdict_token(evidence: str | None) -> str | None:
    if not evidence:
        return None
    m = VERDICT_RE.search(evidence)
    if not m:
        return None
    return {"HOT": "HOT", "PUB": "PUBLISHED", "REV": "REVIEW"}.get(m.group(1).upper())


def is_legacy(evidence: str | None) -> bool:
    if not evidence:
        return True
    m = EV_RE.search(evidence)
    if not m:
        return True
    if int(m.group(1)) < CURRENT_EV or int(m.group(2)) < CURRENT_VD:
        return True
    return m.group(3).upper() != "CURRENT"


def is_actionable(row: sqlite3.Row) -> bool:
    if is_legacy(row["evidence"]):
        return False
    v = verdict_token(row["evidence"])
    if v in (None, "REVIEW"):
        return False
    if row["type"] == "HEALTHCARE" and v not in ("HOT", "PUBLISHED"):
        return False
    if row["type"] == "TENDER":
        cat = (row["category"] or "").upper()
        if cat and cat not in ("GARE_HIGH", "GARE_MEDIUM"):
            return False
    return True


def counts(db: Path) -> dict:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    cur = c.cursor()
    tables = cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    integrity = cur.execute("PRAGMA integrity_check").fetchone()[0]
    schema = [
        dict(r)
        for r in cur.execute("PRAGMA table_info(Lead)").fetchall()
    ]
    total = cur.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
    by_type = dict(cur.execute("SELECT type, COUNT(*) FROM Lead GROUP BY type").fetchall())
    hot = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:HOT]%'"
    ).fetchone()[0]
    pub = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:PUB]%'"
    ).fetchone()[0]
    rev = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[V:REV]%'"
    ).fetchone()[0]
    camp = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Campania'"
    ).fetchone()[0]
    ven = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Veneto'"
    ).fetchone()[0]
    camp_hot = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Campania' AND evidence LIKE '%[V:HOT]%'"
    ).fetchone()[0]
    ven_hot = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE type='HEALTHCARE' AND region='Veneto' AND evidence LIKE '%[V:HOT]%'"
    ).fetchone()[0]
    max_ts = cur.execute("SELECT MAX(lastScannedAt) FROM Lead").fetchone()[0]
    q_markers = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%LEGACY:RESCAN_REQUIRED%'"
    ).fetchone()[0]
    hist_markers = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%SHADOW_HIST_VERDICT%'"
    ).fetchone()[0]
    ev_v = cur.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[EV_V:%'"
    ).fetchone()[0]
    c.close()
    return {
        "integrity": integrity,
        "tables": [t[0] for t in tables],
        "tableCount": len(tables),
        "leadColumns": [s["name"] for s in schema],
        "leadTotal": total,
        "byType": by_type,
        "hot": hot,
        "published": pub,
        "review": rev,
        "sanitaCampania": camp,
        "sanitaVeneto": ven,
        "hotCampania": camp_hot,
        "hotVeneto": ven_hot,
        "maxLastScannedAt": max_ts,
        "quarantineMarkers": q_markers,
        "shadowHistMarkers": hist_markers,
        "evidenceVersionMarkers": ev_v,
        "sha256": sha256_file(db),
        "sizeBytes": db.stat().st_size,
    }


def clean_restore() -> dict:
    assert_env()
    if not BACKUP.exists():
        die(f"immutable backup missing: {BACKUP}")
    bak_sha = sha256_file(BACKUP)
    if bak_sha.lower() != EXPECTED_SHA.lower():
        die(f"backup SHA mismatch: {bak_sha} != {EXPECTED_SHA}")

    # Never reuse partially quarantined DB
    if RERUN_DB.exists():
        RERUN_DB.unlink()
    for suffix in ("-wal", "-shm"):
        p = Path(str(RERUN_DB) + suffix)
        if p.exists():
            p.unlink()

    # Copy from immutable backup only (not from old shadow)
    shutil.copy2(BACKUP, RERUN_DB)
    got = counts(RERUN_DB)
    expected = {
        "leadTotal": 1237,
        "hot": 515,
        "published": 120,
        "review": 242,
        "sanitaCampania": 511,
        "sanitaVeneto": 366,
        "quarantineMarkers": 0,
        "shadowHistMarkers": 0,
    }
    mismatches = {
        k: {"expected": expected[k], "got": got[k]}
        for k in expected
        if got.get(k) != expected[k]
    }
    if mismatches:
        RERUN_DB.unlink(missing_ok=True)
        die(f"restore mismatch vs immutable snapshot: {mismatches}")
    if got["sha256"].lower() != EXPECTED_SHA.lower():
        die("restored file SHA != immutable backup")
    return {"ok": True, "db": str(RERUN_DB.name), "counts": got, "mismatches": {}}


def quarantine_apply(db: Path) -> dict:
    if os.environ.get("SHADOW_ALLOW_DB_WRITE") not in ("true", "1"):
        die("SHADOW_ALLOW_DB_WRITE required")
    if os.environ.get("SHADOW_ALLOW_APPLY") not in ("1", "true"):
        die("SHADOW_ALLOW_APPLY required")
    marker = "[EV_V:2 VD_V:2 LEGACY:RESCAN_REQUIRED]"
    c = sqlite3.connect(str(db))
    c.row_factory = sqlite3.Row
    cur = c.cursor()
    rows = cur.execute(
        "SELECT id, evidence FROM Lead WHERE type='HEALTHCARE'"
    ).fetchall()
    updated = skipped = 0
    for r in rows:
        ev = r["evidence"] or ""
        if "LEGACY:RESCAN_REQUIRED" in ev or "LEGACY:CURRENT" in ev:
            skipped += 1
            continue
        v = verdict_token(ev) or "UNKNOWN"
        cleaned = EV_RE.sub("", ev).strip()
        if "[SHADOW_HIST_VERDICT:" not in cleaned:
            cleaned = f"[SHADOW_HIST_VERDICT:{v}] {cleaned}".strip()
        new_ev = f"{cleaned} {marker}".strip()
        cur.execute("UPDATE Lead SET evidence=? WHERE id=?", (new_ev, r["id"]))
        updated += 1
    c.commit()
    total = cur.execute("SELECT COUNT(*) FROM Lead").fetchone()[0]
    c.close()
    heartbeat()
    return {"updated": updated, "skipped": skipped, "leadTotal": total}


def audit(db: Path) -> dict:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    cur = c.cursor()
    out = {"byRegion": {}, "gareActionable": 0, "sanitaActionable": 0}
    for region in ("Campania", "Veneto"):
        rows = cur.execute(
            "SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=?", (region,)
        ).fetchall()
        stats = {
            "total": len(rows),
            "HOT": 0,
            "PUBLISHED": 0,
            "REVIEW": 0,
            "legacy": 0,
            "legacyHot": 0,
            "legacyPublished": 0,
            "actionable": 0,
            "quarantineMarkers": 0,
        }
        for r in rows:
            v = verdict_token(r["evidence"])
            if v == "HOT":
                stats["HOT"] += 1
            elif v == "PUBLISHED":
                stats["PUBLISHED"] += 1
            elif v == "REVIEW":
                stats["REVIEW"] += 1
            if is_legacy(r["evidence"]):
                stats["legacy"] += 1
                if v == "HOT":
                    stats["legacyHot"] += 1
                if v == "PUBLISHED":
                    stats["legacyPublished"] += 1
            if "LEGACY:RESCAN_REQUIRED" in (r["evidence"] or ""):
                stats["quarantineMarkers"] += 1
            if is_actionable(r):
                stats["actionable"] += 1
                out["sanitaActionable"] += 1
        out["byRegion"][region] = stats
    for r in cur.execute("SELECT * FROM Lead WHERE type='TENDER'").fetchall():
        if is_actionable(r):
            out["gareActionable"] += 1
    c.close()
    return out


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    run_id = os.environ.get("SHADOW_RUN_ID", f"rerun-{datetime.now(timezone.utc).strftime('%H%M%S')}")
    install_signal_handlers()

    if cmd == "verify-backup":
        print(
            json.dumps(
                {
                    "path": str(BACKUP),
                    "sha256": sha256_file(BACKUP),
                    "matchesExpected": sha256_file(BACKUP).lower() == EXPECTED_SHA.lower(),
                    "sizeBytes": BACKUP.stat().st_size,
                },
                indent=2,
            )
        )
        return

    if cmd == "clean-restore":
        assert_env()
        acquire_lock(run_id)
        enforce_timeout(DEFAULT_TIMEOUT_SEC)
        try:
            checkpoint(run_id, "clean-restore:start")
            result = clean_restore()
            checkpoint(run_id, "clean-restore:done", {"sha256": result.get("counts", {}).get("sha256")})
            print(json.dumps(result, indent=2))
        finally:
            clear_timeout()
            release_lock()
        return

    if cmd == "quarantine":
        assert_env()
        acquire_lock(run_id)
        enforce_timeout(DEFAULT_TIMEOUT_SEC)
        try:
            if not RERUN_DB.exists():
                die("rerun db missing — run clean-restore first")
            pre = counts(RERUN_DB)
            if pre["quarantineMarkers"] != 0 or pre["shadowHistMarkers"] != 0:
                die("rerun db already has shadow markers — restore clean first")
            checkpoint(run_id, "quarantine:dry-run")
            dry = audit(RERUN_DB)
            checkpoint(run_id, "quarantine:first-apply")
            first = quarantine_apply(RERUN_DB)
            heartbeat()
            checkpoint(run_id, "quarantine:second-apply", {"firstUpdated": first["updated"]})
            second = quarantine_apply(RERUN_DB)
            after = audit(RERUN_DB)
            post = counts(RERUN_DB)
            checkpoint(
                run_id,
                "quarantine:done",
                {"markers": post["quarantineMarkers"], "idempotent": second["updated"] == 0},
            )
            print(
                json.dumps(
                    {
                        "runId": run_id,
                        "dryRunStats": dry,
                        "firstApply": first,
                        "secondApply": second,
                        "idempotent": second["updated"] == 0,
                        "auditAfter": after,
                        "countsAfter": {
                            "leadTotal": post["leadTotal"],
                            "quarantineMarkers": post["quarantineMarkers"],
                            "hot": post["hot"],
                        },
                        "legacyActionable": after["sanitaActionable"] + after["gareActionable"],
                    },
                    indent=2,
                )
            )
        finally:
            clear_timeout()
            release_lock()
        return

    print("usage: verify-backup | clean-restore | quarantine", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
