"""Independent oracle for Knotwork's name-change sequence (P1-4; Python standard library only).

Two jobs. (1) Every rules file in rules/name-change/ is an order the steps can be done in: steps go federal -> state ->
passport -> accounts and never back; a step waits only for earlier steps in its own or an earlier phase; every
document named exists and is needed; a document that comes out of a step is needed only by steps that (through their
prerequisites) wait for it; exactly one file is the fallback, and every file says it is illustrative and not legal
advice. (2) Every fixture in fixtures/namechange/ replays its moves under the gating rule: a step starts, or is marked
done, only when the steps it waits for are done and the documents it needs are held; a document a step produces is
held only once that step is done; nothing is undone that a later step, or a held product, relies on. Shares no code
with src/lib/knotwork/namechange/."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RULES = REPO / "rules" / "name-change"
ROOT = REPO / "fixtures" / "namechange"
PHASES = ["federal", "state", "passport", "accounts"]


def load_rules() -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text()) for p in sorted(RULES.glob("*.json"))}


def rule_problems(r: dict) -> list[str]:
    out = []
    steps = r["steps"]
    keys = [s["key"] for s in steps]
    if len(set(keys)) != len(keys):
        out.append("duplicate step")
    arts = {a["key"]: a for a in r["artifacts"]}
    if len(arts) != len(r["artifacts"]):
        out.append("duplicate artifact")
    if r.get("illustrative") is not True or "not legal advice" not in r["notice"].lower() or "illustrative" not in r["notice"].lower():
        out.append("not labelled illustrative / not legal advice")
    position = {k: i for i, k in enumerate(keys)}
    upstream: dict[str, set[str]] = {}
    for i, s in enumerate(steps):
        if i and PHASES.index(s["phase"]) < PHASES.index(steps[i - 1]["phase"]):
            out.append(f"{s['key']}: phase goes backwards")
        seen = set()
        for p in s["prerequisites"]:
            if p not in position:
                out.append(f"{s['key']}: unknown prerequisite {p}")
                continue
            if position[p] >= i:
                out.append(f"{s['key']}: prerequisite {p} is not earlier")
                continue
            if PHASES.index(steps[position[p]]["phase"]) > PHASES.index(s["phase"]):
                out.append(f"{s['key']}: prerequisite {p} in a later phase")
            seen |= {p} | upstream[p]
        upstream[s["key"]] = seen
        for a in s["artifacts"]:
            if a not in arts:
                out.append(f"{s['key']}: unknown artifact {a}")
            elif arts[a]["producedBy"] and arts[a]["producedBy"] not in seen:
                out.append(f"{s['key']}: needs {a} without waiting for {arts[a]['producedBy']}")
    for a in r["artifacts"]:
        if a["producedBy"] and a["producedBy"] not in position:
            out.append(f"{a['key']}: produced by an unknown step")
        if not any(a["key"] in s["artifacts"] for s in steps):
            out.append(f"{a['key']}: needed by nobody")
    return out


def _no(code: str, keys=()) -> dict:
    return {"ok": False, "code": code, "keys": sorted(keys)}


def answer(r: dict, status: dict[str, str], held: set[str], op: str, key: str) -> dict:
    by_step = {s["key"]: s for s in r["steps"]}
    by_art = {a["key"]: a for a in r["artifacts"]}
    st = lambda k: status.get(k, "todo")  # noqa: E731
    if op in ("hold", "release"):
        if key not in by_art:
            return _no("unknown-artifact")
        if op == "hold":
            if key in held:
                return _no("already-held")
            maker = by_art[key]["producedBy"]
            if maker and st(maker) != "done":
                return _no("not-produced", [maker])
            return {"ok": True}
        if key not in held:
            return _no("not-held")
        users = [s["key"] for s in r["steps"] if st(s["key"]) == "started" and key in s["artifacts"]]
        return _no("in-use", users) if users else {"ok": True}
    if key not in by_step:
        return _no("unknown-step")
    s = by_step[key]

    def gated():
        waiting = [p for p in s["prerequisites"] if st(p) != "done"]
        if waiting:
            return _no("prerequisites", waiting)
        missing = [a for a in s["artifacts"] if a not in held]
        if missing:
            return _no("artifacts", missing)
        return {"ok": True}

    if op == "start":
        return _no("not-todo") if st(key) != "todo" else gated()
    if op == "finish":
        return _no("already-done") if st(key) == "done" else gated()
    if op == "stop":
        return {"ok": True} if st(key) == "started" else _no("not-started")
    if op == "reopen":
        if st(key) != "done":
            return _no("not-done")
        later = [d["key"] for d in r["steps"] if key in d["prerequisites"] and st(d["key"]) != "todo"]
        if later:
            return _no("dependents", later)
        products = [a["key"] for a in r["artifacts"] if a["producedBy"] == key and a["key"] in held]
        if products:
            return _no("produced-held", products)
        return gated()  # back in progress: it needs its documents again
    raise AssertionError(op)


NEXT_STATUS = {"start": "started", "finish": "done", "stop": "todo", "reopen": "started"}


def invariants(r: dict, status: dict[str, str], held: set[str]) -> list[str]:
    out = []
    for s in r["steps"]:
        st = status.get(s["key"], "todo")
        if st == "todo":
            continue
        if any(status.get(p) != "done" for p in s["prerequisites"]):
            out.append(f"{s['key']} {st} before its prerequisites")
        if st == "started" and any(a not in held for a in s["artifacts"]):
            out.append(f"{s['key']} in progress without its documents")
    for a in r["artifacts"]:
        if a["producedBy"] and a["key"] in held and status.get(a["producedBy"]) != "done":
            out.append(f"{a['key']} held before {a['producedBy']}")
    return out


def expected(fx: dict, rules: dict[str, dict]) -> dict:
    r = rules[fx["rules"]]
    status: dict[str, str] = {}
    held: set[str] = set()
    outcomes = []
    for m in fx["ops"]:
        a = answer(r, status, held, m["op"], m["key"])
        outcomes.append(a)
        if not a["ok"]:
            continue
        if m["op"] == "hold":
            held.add(m["key"])
        elif m["op"] == "release":
            held.discard(m["key"])
        elif NEXT_STATUS[m["op"]] == "todo":
            status.pop(m["key"], None)
        else:
            status[m["key"]] = NEXT_STATUS[m["op"]]
    wedding = dt.date.fromisoformat(fx["weddingDate"])
    nxt = [s["key"] for s in r["steps"] if status.get(s["key"], "todo") == "todo" and answer(r, status, held, "start", s["key"])["ok"]]
    order = [s["key"] for p in PHASES for s in r["steps"] if s["phase"] == p]
    return {
        "outcomes": outcomes,
        "final": {"steps": dict(sorted(status.items())), "held": sorted(held)},
        "invariants": invariants(r, status, held),
        "next": [k for k in order if k in nxt],
        "from": {s["key"]: (wedding + dt.timedelta(days=s["startAfterDays"])).isoformat() for p in PHASES for s in r["steps"] if s["phase"] == p},
    }


def load() -> list[tuple[Path, dict]]:
    return [(p, json.loads(p.read_text())) for p in sorted(ROOT.glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":
    rules = load_rules()
    for name, r in rules.items():
        print(name, rule_problems(r) or "ok")
    for path, fx in load():
        print(path.stem, "ok" if fx.get("expect") == expected(fx, rules) else "DIFF")
