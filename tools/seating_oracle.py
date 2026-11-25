"""Independent oracle for Knotwork's seating chart (P1-5; Python standard library only).

Scores a seating from scratch and checks it against the tables and the rules: every guest seated at a table that
exists, no table over its capacity, every locked guest at the table it is locked to. Hard violations: a guest with no
seat, a seat over capacity, a hard pair broken. Soft: 3 per soft pair broken, 2 per household member away from the
household's largest group at one table. total = hard * 1,000,000 + soft.

Fixtures are small on purpose, so the oracle can also find the best seating by brute force (every guest at every
table, locks respected) and prove the claims a fixture makes: "optimal" (the engine's score is the best there is),
"infeasible" and "unsolved" (no seating at all keeps every hard rule). Shares no code with src/lib/knotwork/seating/."""
from __future__ import annotations

import itertools
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "seating"
HARD, PAIR, HOUSEHOLD = 1_000_000, 3, 2
BRUTE_LIMIT = 200_000  # assignments; the fixtures stay under it


def score(fx, seats) -> dict:
    tables = {t["id"]: t["capacity"] for t in fx["tables"]}
    seat = {g: t for g, t in seats.items() if t in tables}
    guests = [g["id"] for g in fx["guests"]]
    hard = sum(1 for g in guests if g not in seat)
    used = Counter(seat[g] for g in guests if g in seat)
    hard += sum(max(0, n - tables[t]) for t, n in used.items())
    soft = 0
    for r in fx["rules"]:
        if r["a"] not in seat or r["b"] not in seat:
            continue
        same = seat[r["a"]] == seat[r["b"]]
        broken = same if r["kind"] == "apart" else not same
        if broken:
            if r["hard"]:
                hard += 1
            else:
                soft += PAIR
    by_household = defaultdict(Counter)
    for g in fx["guests"]:
        if g["id"] in seat:
            by_household[g["household"]][seat[g["id"]]] += 1
    for counts in by_household.values():
        soft += HOUSEHOLD * (sum(counts.values()) - max(counts.values()))
    return {"hard": hard, "soft": soft, "total": hard * HARD + soft}


def problems(fx, seats) -> list[str]:
    """What is wrong with a seating as a seating (not as a score): unknown tables, over capacity, locks moved."""
    out = []
    tables = {t["id"]: t["capacity"] for t in fx["tables"]}
    for g, t in seats.items():
        if t not in tables:
            out.append(f"{g} at unknown table {t}")
    for t, n in Counter(seats.values()).items():
        if t in tables and n > tables[t]:
            out.append(f"{t} holds {n}, seats {tables[t]}")
    for g, t in fx["locked"].items():
        if seats.get(g) != t:
            out.append(f"{g} is locked at {t}, seated at {seats.get(g)}")
    known = {g["id"] for g in fx["guests"]}
    out += [f"unknown guest {g}" for g in seats if g not in known]
    return out


def brute(fx) -> dict:
    """The best score over every assignment of guests to tables that keeps the locks (capacity is in the score)."""
    tables = [t["id"] for t in fx["tables"]]
    free = [g["id"] for g in fx["guests"] if g["id"] not in fx["locked"]]
    n = len(tables) ** len(free)
    assert n <= BRUTE_LIMIT, f"{fx['name']}: too big for brute force ({n})"
    best = None
    for combo in itertools.product(tables, repeat=len(free)):
        seats = dict(fx["locked"])
        seats.update(zip(free, combo))
        s = score(fx, seats)
        if best is None or s["total"] < best["total"]:
            best = s
    return best


def load():
    return [(p, json.loads(p.read_text())) for p in sorted(ROOT.glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":
    for path, fx in load():
        e = fx["expect"]
        print(path.name, e["status"], score(fx, e["seats"]) if e["seats"] else "-", brute(fx))
