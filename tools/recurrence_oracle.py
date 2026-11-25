"""Independent oracle for Knotwork's life-admin recurrence (Phase 5; Python standard library only).

Today is the calendar day at the fixture's instant in the wedding's time zone (zoneinfo), so a daylight-saving change
never moves it. Month steps keep the day of the month, or take the month's last day when it is shorter (calendar). The
k-th anniversary is the wedding's month and day k years on (Feb 29 becomes Feb 28 outside leap years). An interval task
is due its interval after the latest done day that is not after today (never done: today). An anniversary task's done
day counts for the nearest anniversary (the wedding day is number 0; halfway, the later one) and it is next due on the
one after (never done: the next anniversary on or after today). Shares no code with src/lib/knotwork/lifeadmin/."""
from __future__ import annotations

import calendar
import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "lifeadmin"
SOON = 7
WORDS = {"day": ("day", "days"), "week": ("week", "weeks"), "month": ("month", "months")}


def d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def plus_months(day: dt.date, n: int) -> dt.date:
    y, m = divmod(day.year * 12 + day.month - 1 + n, 12)
    m += 1
    return dt.date(y, m, min(day.day, calendar.monthrange(y, m)[1]))


def nth_anniversary(wedding: dt.date, k: int) -> dt.date:
    y = wedding.year + k
    return dt.date(y, wedding.month, min(wedding.day, calendar.monthrange(y, wedding.month)[1]))


def ordinal(n: int) -> str:
    if 11 <= n % 100 <= 13:
        return f"{n}th"
    return f"{n}" + {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def upcoming(wedding: dt.date, today: dt.date) -> int:
    k = 1
    while nth_anniversary(wedding, k) < today:
        k += 1
    return k


def covered(wedding: dt.date, done: dt.date) -> int:
    if done <= wedding:
        return 0
    after = upcoming(wedding, done)
    before = after - 1
    return before if (done - nth_anniversary(wedding, before)).days < (nth_anniversary(wedding, after) - done).days else after


def rule_text(rule) -> str:
    if rule["unit"] == "anniversary":
        return "every year, on the anniversary"
    one, many = WORDS[rule["unit"]]
    return f"every {one}" if rule["every"] == 1 else f"every {rule['every']} {many}"


def due_of(rule, wedding: dt.date, done, today: dt.date) -> dict:
    facts = [d(x) for x in done if d(x) <= today]
    last = max(facts) if facts else None
    if rule["unit"] == "anniversary":
        due = nth_anniversary(wedding, upcoming(wedding, today)) if last is None else nth_anniversary(wedding, covered(wedding, last) + 1)
    elif last is None:
        due = today
    elif rule["unit"] == "day":
        due = last + dt.timedelta(days=rule["every"])
    elif rule["unit"] == "week":
        due = last + dt.timedelta(weeks=rule["every"])
    else:
        due = plus_months(last, rule["every"])
    late = (today - due).days
    state = "overdue" if late > 0 else "today" if late == 0 else "soon" if -late <= SOON else "later"
    return {"due": due.isoformat(), "never": last is None, "lastDone": last.isoformat() if last else None, "state": state, "overdueDays": late}


def expected(fx) -> dict:
    at = dt.datetime.fromisoformat(fx["at"].replace("Z", "+00:00"))
    today = at.astimezone(ZoneInfo(fx["timeZone"])).date()
    wedding = d(fx["weddingDate"])
    k = upcoming(wedding, today)
    ann = nth_anniversary(wedding, k)
    return {
        "today": today.isoformat(),
        "anniversary": {"k": k, "day": ann.isoformat(), "inDays": (ann - today).days, "today": ann == today, "label": f"{ordinal(k)} anniversary"},
        "tasks": [{"id": t["id"], "rule": rule_text(t["rule"]), **due_of(t["rule"], wedding, t["done"], today)} for t in fx["tasks"]],
        "months": [plus_months(d(m["from"]), m["n"]).isoformat() for m in fx["months"]],
    }


def load():
    return [(p, json.loads(p.read_text())) for p in sorted(ROOT.glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=2) + "\n"


if __name__ == "__main__":
    for path, fx in load():
        print(path.name, "ok" if fx.get("expect") == expected(fx) else "DIFF")
