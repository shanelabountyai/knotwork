"""The consent state machine as a table (Python standard library only).

Writes fixtures/consent/transitions.json: every (status, event, actor, time) with the outcome the rules in
docs/knotwork/PHASE-1-PLAN.md ("The consent machine, exactly") require. src/lib/knotwork/consent/machine.ts is tested
against the file; pytest checks the file equals this table. Written as explicit rules, in a different order from the
TypeScript, so the two are not copies of each other.

Actors: A proposed the request. B is the other partner. C is a third owner. H is a helper (not an owner).
Times: before the expiry instant, exactly at it, after it. A request is expired from the instant onwards.
"""
from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "consent" / "transitions.json"
STATUSES = ["pending", "approved", "declined", "withdrawn", "expired"]
EVENTS = ["approve", "decline", "withdraw", "expire"]
ACTORS = {"A": {"partner": True, "proposer": True}, "B": {"partner": True, "proposer": False}, "C": {"partner": True, "proposer": False}, "H": {"partner": False, "proposer": False}}
TIMES = ["before", "at", "after"]


def outcome(status: str, event: str, actor: str, when: str) -> dict:
    who = ACTORS[actor]
    if status != "pending":
        return {"ok": False, "reason": "already-decided", "status": status}  # terminal states never change
    due = when in ("at", "after")
    if event == "expire":  # the sweep: no actor rule
        return {"ok": True, "status": "expired"} if due else {"ok": False, "reason": "not-due", "status": "pending"}
    if due:
        return {"ok": False, "reason": "expired", "status": "expired"}  # too late for anyone; the request is now expired
    if event == "withdraw":
        return {"ok": True, "status": "withdrawn"} if who["proposer"] else {"ok": False, "reason": "not-the-proposer", "status": "pending"}
    if not who["partner"]:
        return {"ok": False, "reason": "not-a-partner", "status": "pending"}
    if who["proposer"]:
        return {"ok": False, "reason": "own-request", "status": "pending"}  # the second key is never the first
    return {"ok": True, "status": "approved" if event == "approve" else "declined"}


def table() -> list[dict]:
    return [{"status": s, "event": e, "actor": a, "when": w, "expect": outcome(s, e, a, w)} for s in STATUSES for e in EVENTS for a in ACTORS for w in TIMES]


def dump() -> str:
    return json.dumps({"note": __doc__.strip().split("\n\n")[-1].replace("\n", " "), "cases": table()}, indent=1) + "\n"


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(dump())
    print(f"wrote {OUT.name}: {len(table())} cases")
