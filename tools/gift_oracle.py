"""Independent oracle for Knotwork's gift ledger (Python standard library only): partial contributions toward a
target, the fully-funded trigger, clean excess when an offer is more than what remains, refund-on-unfunded at close.
Shares no code with src/lib/knotwork/gifts/. Rules: docs/knotwork/PHASE-3-PLAN.md section 2 (PRD P0-5).

The ledger is a list of signed integer cents; a pot is its sum. Nothing here is a float."""
from __future__ import annotations

import json
from itertools import permutations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "gifts"
MIN_OFFER, MAX_OFFER = 100, 10_000_000


def net(entries) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in entries:
        out[e["householdId"]] = out.get(e["householdId"], 0) + e["amountCents"]
    return dict(sorted(out.items()))


def run(target: int, steps) -> dict:
    entries, state, thanks, results = [], "open", [], []
    for s in steps:
        pot = sum(e["amountCents"] for e in entries)
        if s["op"] == "close":
            if state != "open":
                results.append({"ok": False, "code": "not-open"})
                continue
            refunds = [{"kind": "refund", "amountCents": -n, "householdId": h} for h, n in net(entries).items() if n > 0]
            entries += refunds
            state = "closed_unfunded"
            results.append({"ok": True, "lines": [{"kind": r["kind"], "amountCents": r["amountCents"]} for r in refunds], "potCents": 0, "state": state})
            continue
        offer = s["offerCents"]
        if type(offer) is not int or offer < MIN_OFFER or offer > MAX_OFFER:
            results.append({"ok": False, "code": "amount"})
        elif state == "closed_unfunded":
            results.append({"ok": False, "code": "closed"})
        elif state == "funded" or pot >= target:
            results.append({"ok": False, "code": "funded"})
        else:
            lines = [{"kind": "contribution", "amountCents": offer}]
            over = pot + offer - target
            if over > 0:
                lines.append({"kind": "excess_return", "amountCents": -over})
            entries += [{**line, "householdId": s["household"]} for line in lines]
            pot = min(pot + offer, target)
            if pot == target:
                state = "funded"
                thanks = sorted(h for h, n in net(entries).items() if n > 0)
            results.append({"ok": True, "lines": lines, "potCents": pot, "state": state})
    return {"steps": results, "entries": entries, "potCents": sum(e["amountCents"] for e in entries), "state": state, "net": net(entries), "thankYous": thanks}


def expected(fx) -> dict:
    return run(fx["targetCents"], fx["steps"])


def orders(fx):
    """Every order the fixture's steps could have been served in (the race)."""
    return [run(fx["targetCents"], list(p)) for p in permutations(fx["steps"])]


def load():
    return [(p, json.loads(p.read_text())) for p in sorted(ROOT.glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":
    for path, fx in load():
        want = expected(fx)
        print(path.name, "ok" if fx.get("expect") == want else "DIFF", want["state"], want["potCents"], want["net"])
