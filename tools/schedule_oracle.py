"""Independent oracle for Knotwork's backward scheduler (Python standard library only).

It shares no code with src/lib/knotwork/schedule/engine.ts and uses a different method on purpose: instead of
a backward and a forward pass over a topological order, it enumerates every dependency path and takes the worst one,
and it does date arithmetic with datetime.date. Slow, obvious, and good enough for fixtures.

Rules it checks (docs/knotwork/PHASE-1-PLAN.md, "The scheduler, exactly"):
  need(t)   = lead(t) + max(buffer(t), need of every unfinished task that depends on t)
  startBy   = wedding - need;  due = startBy + lead
  earliest  = today + the longest chain of unfinished dependencies' lead times
  slack     = startBy - earliest
  state     = done | late (due < today) | impossible (slack < 0) | ok
  critical path = the longest chain back from the wedding among unfinished tasks
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "schedule"
HIGH = "￿"  # sorts after any id, so a longer path beats its own prefix on a tie


def day(s: str) -> date:
    return date.fromisoformat(s)


def invalid(tasks: list[dict]) -> dict | None:
    """Why a plan cannot be scheduled at all, or None."""
    ids = [t["id"] for t in tasks]
    if len(set(ids)) != len(ids):
        return {"kind": "duplicate-id", "ids": sorted({i for i in ids if ids.count(i) > 1})}
    bad = sorted(t["id"] for t in tasks if not isinstance(t["leadDays"], int) or not isinstance(t["bufferDays"], int) or t["leadDays"] < 0 or t["bufferDays"] < 0)
    if bad:
        return {"kind": "negative-days", "ids": bad}
    known = set(ids)
    missing = sorted(t["id"] for t in tasks if any(d not in known for d in t["dependsOn"]))
    if missing:
        return {"kind": "missing-dependency", "ids": missing}
    deps = {t["id"]: set(t["dependsOn"]) for t in tasks}

    def reaches(start: str, goal: str) -> bool:
        seen, stack = set(), list(deps[start])
        while stack:
            n = stack.pop()
            if n == goal:
                return True
            if n not in seen:
                seen.add(n)
                stack.extend(deps[n])
        return False

    on_cycle = sorted(i for i in ids if reaches(i, i))
    return {"kind": "cycle", "ids": on_cycle} if on_cycle else None


def _paths_down(tasks: dict[str, dict], dependents: dict[str, list[str]], start: str):
    """Every path start -> dependent -> ... where every task after the first is unfinished."""
    stack = [[start]]
    while stack:
        p = stack.pop()
        yield p
        for u in dependents[p[-1]]:
            if not tasks[u]["done"]:
                stack.append(p + [u])


def _paths_up(tasks: dict[str, dict], t: str):
    """Every chain of unfinished dependencies ending at t (t itself excluded)."""
    stack = [[]]
    while stack:
        chain = stack.pop()
        yield chain
        head = chain[0] if chain else t
        for d in tasks[head]["dependsOn"]:
            if not tasks[d]["done"]:
                stack.append([d] + chain)


def compute(task_list: list[dict], wedding: str, today: str) -> dict:
    bad = invalid(task_list)
    if bad:
        return {"invalid": bad}
    tasks = {t["id"]: t for t in task_list}
    dependents: dict[str, list[str]] = {i: [] for i in tasks}
    for t in task_list:
        for d in t["dependsOn"]:
            dependents[d].append(t["id"])
    w, now = day(wedding), day(today)

    def score(path: list[str]) -> int:
        return sum(tasks[i]["leadDays"] for i in path) + tasks[path[-1]]["bufferDays"]

    out: dict[str, dict] = {}
    for i, t in tasks.items():
        need = max(score(p) for p in _paths_down(tasks, dependents, i))
        start_by = w - timedelta(days=need)
        due = start_by + timedelta(days=t["leadDays"])
        if t["done"]:
            out[i] = {"due": due.isoformat(), "startBy": start_by.isoformat(), "earliestStart": None, "slackDays": None, "needDays": None, "state": "done"}
            continue
        earliest = now + timedelta(days=max(sum(tasks[j]["leadDays"] for j in chain) for chain in _paths_up(tasks, i)))
        slack = (start_by - earliest).days
        state = "late" if due < now else "impossible" if slack < 0 else "ok"
        out[i] = {"due": due.isoformat(), "startBy": start_by.isoformat(), "earliestStart": earliest.isoformat(), "slackDays": slack, "needDays": need, "state": state}

    open_ids = [i for i in tasks if not tasks[i]["done"]]
    best: list[str] = []
    runway = 0
    if open_ids:
        candidates = [p for i in open_ids for p in _paths_down(tasks, dependents, i)]
        runway = max(score(p) for p in candidates)
        best = min((p for p in candidates if score(p) == runway), key=lambda p: p + [HIGH])
    return {"invalid": None, "tasks": out, "criticalPath": best, "runwayDays": runway, "marginDays": (w - now).days - runway if open_ids else None}


def fingerprint(to: str, tasks: dict[str, dict]) -> str:
    text = "knotwork-move-v1\n" + to + "\n" + "".join(f"{i}|{tasks[i]['due']}|{tasks[i]['startBy']}|{tasks[i]['state']}\n" for i in sorted(tasks))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def preview_move(task_list: list[dict], wedding: str, to: str, today: str) -> dict:
    before, after = compute(task_list, wedding, today), compute(task_list, to, today)
    b, a = before["tasks"], after["tasks"]
    trouble = ("late", "impossible")
    return {
        "deltaDays": (day(to) - day(wedding)).days,
        "tasks": {i: {"due": a[i]["due"], "startBy": a[i]["startBy"], "state": a[i]["state"]} for i in sorted(a)},
        "late": [{"id": i, "isNew": b[i]["state"] != "late"} for i in sorted(a) if a[i]["state"] == "late"],
        "impossible": [{"id": i, "isNew": b[i]["state"] != "impossible"} for i in sorted(a) if a[i]["state"] == "impossible"],
        "resolved": [i for i in sorted(a) if b[i]["state"] in trouble and a[i]["state"] == "ok"],
        "marginDays": after["marginDays"],
        "fingerprint": fingerprint(to, a),
    }


def expected(fx: dict) -> dict:
    """The fixture with its expect blocks recomputed."""
    out = {k: v for k, v in fx.items() if k not in ("expect", "move")}
    out["expect"] = compute(fx["tasks"], fx["weddingDate"], fx["today"])
    if "move" in fx:
        out["move"] = {"to": fx["move"]["to"], "expect": preview_move(fx["tasks"], fx["weddingDate"], fx["move"]["to"], fx["today"])}
    return out


def load() -> list[tuple[Path, dict]]:
    return [(p, json.loads(p.read_text())) for p in sorted(FIXTURES.glob("*.json"))]


def dump(fx: dict) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":  # --write rewrites every fixture's expect blocks; --stdin answers a JSON list of plans
    import sys

    if "--stdin" in sys.argv:
        plans = json.load(sys.stdin)
        print(json.dumps([{"expect": compute(p["tasks"], p["weddingDate"], p["today"]), "move": preview_move(p["tasks"], p["weddingDate"], p["to"], p["today"])} for p in plans]))
        sys.exit(0)

    for path, fx in load():
        text = dump(expected(fx))
        if "--write" in sys.argv:
            path.write_text(text)
        print(("wrote " if "--write" in sys.argv else "same  " if text == path.read_text() else "DIFF  ") + path.name)
