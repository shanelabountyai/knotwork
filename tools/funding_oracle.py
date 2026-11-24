"""Independent oracle for Knotwork's multi-funder family budget (P1-2; Python standard library only).

A funder pledges toward one budget category; money arrives against the pledge (received, in parts); received money
is spent by paying part of an expense in that category (an allocation). Per pledge: pledged >= received >= spent.
Per expense: what the pledges paid is at most its amount. Shares no code with src/lib/knotwork/funding/.
Amounts are integer cents; nothing here is a float."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "funding"
MIN_PLEDGE, MAX = 100, 100_000_000


def ok_amount(n) -> bool:
    return type(n) is int and MIN_PLEDGE <= n <= MAX


def ok_part(n) -> bool:
    return type(n) is int and 1 <= n <= MAX


def stage(pledged: int, received: int, spent: int) -> str:
    if received == 0:
        return "pledged"
    if received < pledged:
        return "partly_received"
    return "spent" if spent >= pledged else "received"


def lines(pledges: dict, receipts: dict, allocations: dict) -> list[dict]:
    out = []
    for pid in sorted(pledges):
        p = pledges[pid]
        got = sum(r["amount"] for r in receipts.values() if r["pledge"] == pid)
        spent = sum(a["amount"] for a in allocations.values() if a["pledge"] == pid)
        out.append({
            "pledgeId": pid, "funderId": p["funder"], "categoryId": p["category"],
            "pledgedCents": p["amount"], "receivedCents": got, "spentCents": spent,
            "outstandingCents": p["amount"] - got, "unspentCents": got - spent, "stage": stage(p["amount"], got, spent),
        })
    return out


def mix(ls: list[dict]) -> list[dict]:
    out = []
    for cat in sorted({x["categoryId"] for x in ls}):
        ps = [x for x in ls if x["categoryId"] == cat]
        out.append({
            "categoryId": cat,
            "pledgedCents": sum(x["pledgedCents"] for x in ps),
            "receivedCents": sum(x["receivedCents"] for x in ps),
            "spentCents": sum(x["spentCents"] for x in ps),
            "pledges": ps,
        })
    return out


def run(steps) -> dict:
    pledges, receipts, allocations, expenses, results = {}, {}, {}, {}, []

    def line(pid):
        return next((x for x in lines(pledges, receipts, allocations) if x["pledgeId"] == pid), None)

    def result(code=None):
        results.append({"ok": True} if code is None else {"ok": False, "code": code})

    for s in steps:
        op = s["op"]
        if op == "expense":
            expenses[s["id"]] = {"category": s["category"], "amount": s["amountCents"]}
            result()
        elif op == "pledge":
            if not ok_amount(s["amountCents"]):
                result("amount")
            elif any(p["funder"] == s["funder"] and p["category"] == s["category"] for p in pledges.values()):
                result("duplicate")
            else:
                pledges[s["id"]] = {"funder": s["funder"], "category": s["category"], "amount": s["amountCents"]}
                result()
        elif op == "repledge":
            ln = line(s["pledge"])
            if ln is None:
                result("unknown")
            elif not ok_amount(s["amountCents"]):
                result("amount")
            elif s["amountCents"] < ln["receivedCents"]:
                result("below-received")
            else:
                pledges[s["pledge"]]["amount"] = s["amountCents"]
                result()
        elif op == "receive":
            ln = line(s["pledge"])
            if ln is None:
                result("unknown")
            elif not ok_part(s["amountCents"]):
                result("amount")
            elif s["amountCents"] > ln["pledgedCents"] - ln["receivedCents"]:
                result("over-pledge")
            else:
                receipts[s["id"]] = {"pledge": s["pledge"], "amount": s["amountCents"]}
                result()
        elif op == "unreceive":
            r = receipts.get(s["receipt"])
            if r is None:
                result("unknown")
            else:
                ln = line(r["pledge"])
                if ln["receivedCents"] - r["amount"] < ln["spentCents"]:
                    result("spent")
                else:
                    del receipts[s["receipt"]]
                    result()
        elif op == "spend":
            ln, e = line(s["pledge"]), expenses.get(s["expense"])
            paid = sum(a["amount"] for a in allocations.values() if a["expense"] == s["expense"])
            if ln is None or e is None:
                result("unknown")
            elif any(a["pledge"] == s["pledge"] and a["expense"] == s["expense"] for a in allocations.values()):
                result("duplicate")
            elif not ok_part(s["amountCents"]):
                result("amount")
            elif e["category"] != ln["categoryId"]:
                result("wrong-category")
            elif s["amountCents"] > ln["receivedCents"] - ln["spentCents"]:
                result("over-received")
            elif paid + s["amountCents"] > e["amount"]:
                result("over-expense")
            else:
                allocations[s["id"]] = {"pledge": s["pledge"], "expense": s["expense"], "amount": s["amountCents"]}
                result()
        elif op == "unspend":
            if s["allocation"] in allocations:
                del allocations[s["allocation"]]
                result()
            else:
                result("unknown")
        else:
            raise ValueError(op)
    ls = lines(pledges, receipts, allocations)
    return {"steps": results, "pledges": ls, "categories": mix(ls)}


def expected(fx) -> dict:
    return run(fx["steps"])


def load():
    return [(p, json.loads(p.read_text())) for p in sorted(ROOT.glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":
    for path, fx in load():
        print(path.name, "ok" if fx.get("expect") == expected(fx) else "DIFF")
