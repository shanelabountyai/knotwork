"""Independent oracle for Knotwork's photo wall (Python standard library only): the upload limits and the moderation
table. Shares no code with src/lib/knotwork/photos/. Rules: docs/knotwork/PHASE-3-PLAN.md section 3 (PRD P0-6).

Limits. Counters are fixed windows keyed by (what, who, window number), as src/core/rate-limit.ts counts them. For
each upload, in order: a blocked device is refused and nothing is counted; then the device counter, the address
counter and the event counter are each incremented and compared, stopping at the first one over its limit. A refused
try has already been counted (so hammering does not help), and counters after the refusing one are not touched."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIMITS_DIR = ROOT / "fixtures" / "photos" / "limits"
MODERATION = ROOT / "fixtures" / "photos" / "moderation.json"
RULES = json.loads((ROOT / "rules" / "photo-limits.json").read_text())


def expand(steps) -> list[dict]:
    out = []
    for s in steps:
        if "count" in s:
            for i in range(s["count"]):
                out.append({"t": s["from"] + i * s["every"], "device": s["devices"][i % len(s["devices"])], "address": s["address"]})
        else:
            out.append(dict(s))
    return [a for _, _, a in sorted(((a["t"], i, a) for i, a in enumerate(out)), key=lambda x: (x[0], x[1]))]


def outcomes(limits: dict, attempts: list[dict], blocked=()) -> list[str]:
    counts: dict[tuple, int] = {}

    def over(what: str, who: str, t: int) -> bool:
        w = limits[{"device": "perDevice", "address": "perAddress", "event": "perEvent"}[what]]
        key = (what, who, t // (w["windowMinutes"] * 60))
        counts[key] = counts.get(key, 0) + 1
        return counts[key] > w["limit"]

    result = []
    for a in attempts:
        if a["device"] in blocked:
            result.append("blocked")
        elif over("device", a["device"], a["t"]):
            result.append("device")
        elif over("address", a["address"], a["t"]):
            result.append("address")
        elif over("event", "", a["t"]):
            result.append("event")
        else:
            result.append("ok")
    return result


def expected(fx: dict) -> dict:
    got = outcomes(fx.get("limits") or RULES["upload"], expand(fx["steps"]), fx.get("blocked", ()))
    runs: list[list] = []
    for o in got:
        if runs and runs[-1][0] == o:
            runs[-1][1] += 1
        else:
            runs.append([o, 1])
    return {"attempts": len(got), "totals": {k: got.count(k) for k in sorted(set(got))}, "runs": runs}


def load() -> list[tuple[Path, dict]]:
    return [(p, json.loads(p.read_text())) for p in sorted(LIMITS_DIR.glob("*.json"))]


def dump(fx: dict) -> str:
    return json.dumps(fx, indent=2, ensure_ascii=False) + "\n"


# --- moderation: the table, written out by hand ----------------------------------------------------------------------
# (status, removedFrom) x action -> the next (status, removedFrom), or the refusal code. The mode changes only where a
# photo starts; a purged photo takes no move.
INITIAL = {"pre": "pending", "post": "live"}
MOVES = {
    ("pending", None): {"approve": ("live", None), "reject": ("removed", "pending"), "take_down": "not-live", "undo": "not-removed"},
    ("live", None): {"approve": "not-pending", "reject": "not-pending", "take_down": ("removed", "live"), "undo": "not-removed"},
    ("removed", "pending"): {"approve": "not-pending", "reject": "not-pending", "take_down": "not-live", "undo": ("pending", None)},
    ("removed", "live"): {"approve": "not-pending", "reject": "not-pending", "take_down": "not-live", "undo": ("live", None)},
}


def move(state: dict, action: str, purged: bool) -> dict:
    if purged:
        return {"ok": False, "code": "purged"}
    r = MOVES[(state["status"], state["removedFrom"])][action]
    if isinstance(r, str):
        return {"ok": False, "code": r}
    return {"ok": True, "next": {"status": r[0], "removedFrom": r[1]}}


def visible(p: dict) -> tuple[bool, bool]:
    shown = p["status"] == "live" and not p["purged"]
    return shown and not p["hiddenFromWall"], shown and not p["hiddenFromAlbum"]
