#!/usr/bin/env python3
"""Read-only logical drift: immutable backup vs live (on Hetzner). Aggregate only — no PII."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone

LIVE = "/opt/leadsniper/prisma/dev.db"
BAK = "/opt/leadsniper/backups/giorgio-live-20260718.db"
EXPECTED = "cfb9e8781b2fb03c8989e3b79843cfbebb0742119c91e847e227a459909063ab"


def file_sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def open_ro(path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def tables(conn: sqlite3.Connection) -> list[str]:
    return [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
    ]


def row_count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]


def lead_maps(conn: sqlite3.Connection) -> dict[str, tuple]:
    """id -> (evidence_fp, website, region, score, lastScannedAt, verdict_token)"""
    out = {}
    for r in conn.execute(
        "SELECT id, evidence, website, region, leadScore, lastScannedAt FROM Lead"
    ):
        ev = r[1] or ""
        # fingerprint without storing evidence text
        fp = hashlib.sha256(ev.encode("utf-8", errors="replace")).hexdigest()[:16]
        v = None
        if "[V:HOT]" in ev:
            v = "HOT"
        elif "[V:PUB]" in ev:
            v = "PUB"
        elif "[V:REV]" in ev:
            v = "REV"
        out[r[0]] = (fp, r[2], r[3], r[4], r[5], v)
    return out


def main() -> None:
    bak_sha = file_sha(BAK)
    live_sha = file_sha(LIVE)
    assert bak_sha.lower() == EXPECTED.lower(), f"backup mutated! {bak_sha}"

    b = open_ro(BAK)
    l = open_ro(LIVE)
    bt, lt = tables(b), tables(l)
    table_diff = {
        "onlyBackup": sorted(set(bt) - set(lt)),
        "onlyLive": sorted(set(lt) - set(bt)),
        "shared": sorted(set(bt) & set(lt)),
        "rowCounts": {},
    }
    for t in sorted(set(bt) | set(lt)):
        bc = row_count(b, t) if t in bt else None
        lc = row_count(l, t) if t in lt else None
        table_diff["rowCounts"][t] = {
            "backup": bc,
            "live": lc,
            "delta": (lc - bc) if bc is not None and lc is not None else None,
        }

    # per-table max timestamps (Lead only schema in this snapshot)
    table_maxes = {}
    for t in sorted(set(bt) | set(lt)):
        cols = set()
        src = b if t in bt else l
        for row in src.execute(f'PRAGMA table_info("{t}")'):
            cols.add(row[1])
        entry = {"maxCreatedAt": None, "maxUpdatedAt": None, "maxPkHash": None}
        if "createdAt" in cols and t in bt and t in lt:
            entry["maxCreatedAt"] = {
                "backup": b.execute(f'SELECT max(createdAt) FROM "{t}"').fetchone()[0],
                "live": l.execute(f'SELECT max(createdAt) FROM "{t}"').fetchone()[0],
            }
        if "updatedAt" in cols and t in bt and t in lt:
            entry["maxUpdatedAt"] = {
                "backup": b.execute(f'SELECT max(updatedAt) FROM "{t}"').fetchone()[0],
                "live": l.execute(f'SELECT max(updatedAt) FROM "{t}"').fetchone()[0],
            }
        if "id" in cols and t in bt and t in lt:
            bid = b.execute(f'SELECT max(id) FROM "{t}"').fetchone()[0]
            lid = l.execute(f'SELECT max(id) FROM "{t}"').fetchone()[0]
            entry["maxPkHash"] = {
                "backup": hashlib.sha256(str(bid).encode()).hexdigest()[:12] if bid else None,
                "live": hashlib.sha256(str(lid).encode()).hexdigest()[:12] if lid else None,
                "equal": bid == lid,
            }
        table_maxes[t] = entry
    table_diff["maxTimestamps"] = table_maxes

    bm, lm = lead_maps(b), lead_maps(l)
    ids_b, ids_l = set(bm), set(lm)
    only_b = sorted(ids_b - ids_l)
    only_l = sorted(ids_l - ids_b)
    both = ids_b & ids_l

    changed_fp = changed_website = changed_region = changed_score = changed_ts = changed_verdict = 0
    changed_updated = 0
    verdict_transitions = {}
    # also compare updatedAt when available
    bu = {
        r[0]: r[1]
        for r in b.execute("SELECT id, updatedAt FROM Lead")
    }
    lu = {
        r[0]: r[1]
        for r in l.execute("SELECT id, updatedAt FROM Lead")
    }
    for i in both:
        bb, ll = bm[i], lm[i]
        if bb[0] != ll[0]:
            changed_fp += 1
        if bb[1] != ll[1]:
            changed_website += 1
        if bb[2] != ll[2]:
            changed_region += 1
        if bb[3] != ll[3]:
            changed_score += 1
        if bb[4] != ll[4]:
            changed_ts += 1
        if bb[5] != ll[5]:
            changed_verdict += 1
            key = f"{bb[5]}->{ll[5]}"
            verdict_transitions[key] = verdict_transitions.get(key, 0) + 1
        if bu.get(i) != lu.get(i):
            changed_updated += 1

    q_live = l.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%LEGACY:RESCAN_REQUIRED%'"
    ).fetchone()[0]
    hist_live = l.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%SHADOW_HIST_VERDICT%'"
    ).fetchone()[0]
    ev_live = l.execute(
        "SELECT COUNT(*) FROM Lead WHERE evidence LIKE '%[EV_V:%'"
    ).fetchone()[0]

    # classification
    classification = "NO_LOGICAL_DRIFT"
    if only_b or only_l or changed_verdict or changed_website or changed_region:
        if changed_verdict:
            classification = "VERDICT_CHANGED"
        elif only_b or only_l or changed_website or changed_region:
            classification = "LEAD_DATA_CHANGED"
        else:
            classification = "UNEXPLAINED_DRIFT"
    elif changed_fp or changed_score or changed_ts or changed_updated:
        # evidence fingerprint or score/ts without verdict token change
        if changed_fp and not changed_verdict:
            classification = "LEAD_DATA_CHANGED"
        elif (changed_ts or changed_updated) and not (changed_fp or changed_score):
            classification = "METADATA_ONLY"
        else:
            classification = "EXPECTED_PRODUCTION_ACTIVITY"
    elif live_sha != bak_sha:
        classification = "METADATA_ONLY"  # binary drift only (sqlite housekeeping)

    # refine: if only binary file hash differs and zero logical field diffs
    logical_zero = (
        not only_b
        and not only_l
        and changed_fp == 0
        and changed_website == 0
        and changed_region == 0
        and changed_score == 0
        and changed_ts == 0
        and changed_updated == 0
        and changed_verdict == 0
    )
    if live_sha != bak_sha and logical_zero:
        classification = "METADATA_ONLY"

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "backupSha256": bak_sha,
        "liveSha256": live_sha,
        "backupImmutable": bak_sha.lower() == EXPECTED.lower(),
        "temporalRule": (
            "All shadow results refer to backup SHA "
            f"{EXPECTED} and exclude subsequent production writes."
        ),
        "tableDiff": table_diff,
        "leadDiff": {
            "onlyInBackup": len(only_b),
            "onlyInLive": len(only_l),
            "shared": len(both),
            "changedEvidenceFingerprint": changed_fp,
            "changedWebsite": changed_website,
            "changedRegion": changed_region,
            "changedScore": changed_score,
            "changedLastScannedAt": changed_ts,
            "changedUpdatedAt": changed_updated,
            "changedVerdictToken": changed_verdict,
            "verdictTransitions": verdict_transitions,
            # sample ids only as opaque hashes of ids (no company names)
            "onlyInBackupIdHashes": [
                hashlib.sha256(x.encode()).hexdigest()[:12] for x in only_b[:20]
            ],
            "onlyInLiveIdHashes": [
                hashlib.sha256(x.encode()).hexdigest()[:12] for x in only_l[:20]
            ],
        },
        "liveQuarantineMarkers": q_live,
        "liveShadowHistMarkers": hist_live,
        "liveEvidenceVersionMarkers": ev_live,
        "classification": classification,
    }
    b.close()
    l.close()
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
