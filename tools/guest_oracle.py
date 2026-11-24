"""Independent oracle for Knotwork's guest math (Python standard library only): plus-one entitlement, held seats,
the cap, the backfill release plan, the lockout, and headcount cost. Shares no code with src/lib/knotwork/guests/.
Rules: docs/knotwork/PHASE-2-PLAN.md, "Cap math, exactly"."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "guests"
GRANTING = {"engaged", "married", "long_distance"}


def active(h):
    return [g for g in h["guests"] if not g["removed"]]


def entitled(h) -> bool:
    if h["plusOneOverride"] == "grant":
        return True
    if h["plusOneOverride"] == "deny":
        return False
    adults = [g for g in active(h) if g["ageGroup"] == "adult" and not g["isPlusOne"]]
    return len(adults) == 1 and (adults[0]["inWeddingParty"] or adults[0]["partnerStatus"] in GRANTING)


def held(h) -> int:
    if h["state"] != "invited":
        return 0
    seats = sum(1 for g in active(h) if g["rsvp"] != "declined")
    has_plus = any(g["isPlusOne"] for g in active(h))
    waiting = any(g["rsvp"] == "pending" and g["ageGroup"] == "adult" and not g["isPlusOne"] for g in active(h))
    return seats + (1 if entitled(h) and not has_plus and waiting else 0)


def needed(h) -> int:
    return len(active(h)) + (1 if entitled(h) else 0)


def cap_state(fx) -> dict:
    hs = fx["households"]
    total = sum(held(h) for h in hs)
    attending = sum(1 for h in hs if h["state"] == "invited" for g in active(h) if g["rsvp"] == "attending")
    declined = sum(1 for h in hs if h["state"] == "invited" for g in active(h) if g["rsvp"] == "declined")
    return {"cap": fx["cap"], "held": total, "attending": attending, "pending": total - attending, "declined": declined, "available": fx["cap"] - total}


def release(fx) -> dict:
    hs, lst = fx["households"], fx["list"]
    queued = sorted((h for h in hs if h["state"] == "queued" and h["list"] == lst), key=lambda h: (h["priority"], h["name"], h["id"]))
    none = lambda reason: {"ids": [], "seats": 0, "reason": reason}
    if not queued:
        return none("nothing-queued")
    if lst == "B":
        if any(h["state"] == "queued" and h["list"] == "A" for h in hs):
            return none("a-list-waiting")
        if fx["daysToWedding"] < fx["lockoutDays"]:
            return none("locked-out")
    room = fx["cap"] - sum(held(h) for h in hs)
    ids, seats = [], 0
    for h in queued:
        if needed(h) <= room - seats:
            ids.append(h["id"])
            seats += needed(h)
    if not ids:
        return none("no-room")
    if lst == "B" and seats < fx["minBatchSeats"] and len(ids) != len(queued):
        return none("below-batch")
    return {"ids": ids, "seats": seats, "reason": "ok"}


def regrets(fx) -> list[str]:
    if fx["daysToWedding"] >= fx["lockoutDays"]:
        return []
    return sorted(h["id"] for h in fx["households"] if h["state"] == "queued" and h["list"] == "B")


def expected_backfill(fx) -> dict:
    hs = fx["households"]
    return {"entitled": {h["id"]: entitled(h) for h in hs}, "held": {h["id"]: held(h) for h in hs}, "needed": {h["id"]: needed(h) for h in hs}, "state": cap_state(fx), "release": release(fx), "regrets": regrets(fx)}


def headcount(fx) -> dict:
    going = [g for h in fx["households"] if h["state"] == "invited" for g in active(h) if g["rsvp"] == "attending"]
    invited = [g for h in fx["households"] if h["state"] == "invited" for g in active(h)]
    adults = sum(1 for g in going if g["ageGroup"] == "adult")
    kids = sum(1 for g in going if g["ageGroup"] == "child")
    infants = sum(1 for g in going if g["ageGroup"] == "infant")
    responded = sum(1 for g in invited if g["rsvp"] != "pending")
    p = fx["prices"]
    return {
        "attending": len(going), "adults": adults, "kids": kids, "infants": infants, "vendorMeals": fx["onSiteVendors"],
        "catererMeals": adults + kids + fx["onSiteVendors"], "invited": len(invited), "responded": responded,
        "pending": len(invited) - responded, "declined": responded - len(going),
        "responseRatePct": (responded * 100) // len(invited) if invited else 0,
        "costCents": adults * p["perHeadCents"] + kids * p["kidsMealCents"] + fx["onSiteVendors"] * p["vendorMealCents"],
    }


def load_backfill():
    return [(p, json.loads(p.read_text())) for p in sorted((ROOT / "backfill").glob("*.json"))]


def dump(fx) -> str:
    return json.dumps(fx, indent=1) + "\n"


if __name__ == "__main__":  # --write fills in every expect block
    import sys

    for path, fx in load_backfill():
        fx = {k: v for k, v in fx.items() if k != "expect"}
        fx["expect"] = expected_backfill(fx)
        if "--write" in sys.argv:
            path.write_text(dump(fx))
        print(path.name, fx["expect"]["state"], fx["expect"]["release"])
    hp = ROOT / "headcount.json"
    if hp.exists():
        fx = json.loads(hp.read_text())
        print("headcount", headcount(fx))
