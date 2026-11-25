"""Independent oracle for Knotwork's thank-you obligation ledger (P1-3; Python standard library only).

One obligation per gift and giver: received on a day, acknowledged (sent) on a day or not yet. How long a thank-you
has been owed is whole calendar days from received-on to today (never below zero); "unthanked > 3 weeks" is more than
21 days. Still-owed obligations come oldest first, thanked ones most recently sent first. Shares no code with
src/lib/knotwork/thanks/."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "thanks"
OVERDUE = 21
BUCKETS = [("fresh", "Under a week", 0, 6), ("weeks", "1 to 3 weeks", 7, 21), ("late", "3 to 6 weeks", 22, 42), ("later", "Over 6 weeks", 43, None)]
SOURCE_RANK = {"pooled": 0, "claimed": 1, "logged": 2}


def days_between(later: str, earlier: str) -> int:
    return (dt.date.fromisoformat(later) - dt.date.fromisoformat(earlier)).days


def bucket(days: int) -> str:
    for key, _, lo, hi in BUCKETS:
        if days >= lo and (hi is None or days <= hi):
            return key
    raise AssertionError(days)


def expected(fx) -> dict:
    today = fx["today"]
    owed, thanked = [], []
    for o in fx["obligations"]:
        if o["acknowledgedOn"] is None:
            age = max(0, days_between(today, o["receivedOn"]))
            owed.append({**o, "ageDays": age, "bucket": bucket(age), "overdue": age > OVERDUE})
        else:
            thanked.append(dict(o))
    owed.sort(key=lambda o: (o["receivedOn"], o["giver"], o["what"], SOURCE_RANK[o["source"]], o["id"]))
    # Most recently sent first; ties as for the owed. Two stable sorts: the tie-break first, then the date descending.
    thanked.sort(key=lambda o: (o["receivedOn"], o["giver"], o["what"], SOURCE_RANK[o["source"]], o["id"]))
    thanked.sort(key=lambda o: o["acknowledgedOn"], reverse=True)
    overdue = sum(1 for o in owed if o["overdue"])
    return {
        "owed": owed,
        "thanked": thanked,
        "total": len(fx["obligations"]),
        "overdue": overdue,
        "headline": f"{overdue} unthanked > 3 weeks",
        "buckets": [{"key": k, "label": label, "count": sum(1 for o in owed if o["bucket"] == k)} for k, label, _, _ in BUCKETS],
    }


def load():
    return [(p, json.loads(p.read_text())) for p in sorted(ROOT.glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":
    for path, fx in load():
        print(path.name, "ok" if fx.get("expect") == expected(fx) else "DIFF")
