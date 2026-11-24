"""pytest: every schedule fixture's committed expectations equal what the oracle computes."""
import json

import pytest

import schedule_oracle as oracle

FIXTURES = oracle.load()


def test_there_are_fixtures():
    assert len(FIXTURES) >= 15


@pytest.mark.parametrize("path,fx", FIXTURES, ids=[p.stem for p, _ in FIXTURES])
def test_expectations_match_the_oracle(path, fx):
    assert "expect" in fx, "fixture has no expect block"
    want = oracle.expected(fx)
    assert fx["expect"] == want["expect"]
    if "move" in fx:
        assert fx["move"] == want["move"]
    assert path.read_text() == oracle.dump(fx), "fixture is not in canonical JSON form"


def test_hand_worked_single_task():
    # 2027-10-09 minus 14 days is 2027-09-25; minus 30 more is 2027-08-26.
    r = oracle.compute([{"id": "a", "leadDays": 30, "bufferDays": 14, "dependsOn": [], "done": False}], "2027-10-09", "2026-11-23")
    assert (r["tasks"]["a"]["due"], r["tasks"]["a"]["startBy"], r["tasks"]["a"]["state"]) == ("2027-09-25", "2027-08-26", "ok")


def test_hand_worked_impossible_runway():
    # Wedding 2027-01-22, buffer 30 -> due 2026-12-23 (still ahead of 2026-11-23); lead 45 -> start-by 2026-11-08, 15 days gone.
    r = oracle.compute([{"id": "a", "leadDays": 45, "bufferDays": 30, "dependsOn": [], "done": False}], "2027-01-22", "2026-11-23")
    assert r["tasks"]["a"] == {"due": "2026-12-23", "startBy": "2026-11-08", "earliestStart": "2026-11-23", "slackDays": -15, "needDays": 75, "state": "impossible"}


def test_a_move_shifts_every_open_task_by_exactly_the_delta():
    for _, fx in FIXTURES:
        if "move" not in fx:
            continue
        from datetime import date

        delta = fx["move"]["expect"]["deltaDays"]
        for i, t in fx["expect"]["tasks"].items():
            after = fx["move"]["expect"]["tasks"][i]
            assert (date.fromisoformat(after["due"]) - date.fromisoformat(t["due"])).days == delta
            assert (date.fromisoformat(after["startBy"]) - date.fromisoformat(t["startBy"])).days == delta


def test_fingerprint_is_sixteen_hex():
    for _, fx in FIXTURES:
        if "move" in fx:
            fp = fx["move"]["expect"]["fingerprint"]
            assert len(fp) == 16 and int(fp, 16) >= 0
    assert json.dumps({"ok": True})


# --- consent state machine -------------------------------------------------------------------------------------------
import consent_table


def test_consent_table_is_the_committed_fixture():
    assert consent_table.OUT.read_text() == consent_table.dump()


def test_consent_table_shape():
    cases = consent_table.table()
    assert len(cases) == 5 * 4 * 4 * 3
    approved = [c for c in cases if c["expect"] == {"ok": True, "status": "approved"}]
    # Only a different partner, on a pending request, before expiry, can turn the second key.
    assert sorted((c["actor"], c["when"], c["status"], c["event"]) for c in approved) == [("B", "before", "pending", "approve"), ("C", "before", "pending", "approve")]
    assert not [c for c in cases if c["expect"]["ok"] and c["actor"] == "A" and c["event"] in ("approve", "decline")]
    assert not [c for c in cases if c["expect"]["ok"] and c["status"] != "pending"]


# --- budget rollup ---------------------------------------------------------------------------------------------------
import budget_oracle

BUDGET = oracle.FIXTURES.parent / "budget" / "rollup.json"


def test_budget_rollup_matches_the_oracle_and_the_hand_sums():
    fx = json.loads(BUDGET.read_text())
    assert budget_oracle.rollup(fx["categories"], fx["expenses"]) == fx["expect"]
    assert fx["expect"]["actualCents"] == 600000 + 250000 + 1250050 + 80000 + 1 == 2180051
    assert fx["expect"]["estimateCents"] == 900000 + 1200000 + 300000 + 150000 == 2550000
    assert all(isinstance(e["amountCents"], int) for e in fx["expenses"])


# --- guests: backfill cap math and headcount cost -----------------------------------------------------------------
import guest_oracle

BACKFILL = guest_oracle.load_backfill()


def test_there_are_backfill_fixtures():
    assert len(BACKFILL) >= 12


@pytest.mark.parametrize("path,fx", BACKFILL, ids=[p.stem for p, _ in BACKFILL])
def test_backfill_expectations_match_the_oracle(path, fx):
    assert fx["expect"] == guest_oracle.expected_backfill(fx)
    assert path.read_text() == guest_oracle.dump(fx)
    assert fx["expect"]["state"]["held"] <= fx["cap"], "fixtures start within the cap"
    # Releasing what the plan says never passes the cap.
    assert fx["expect"]["state"]["held"] + fx["expect"]["release"]["seats"] <= fx["cap"]


def test_overbooking_case_by_hand():
    # Cap 8. Invited: 2 attending, 2 pending (they hold their seats), 2 declined. Held 4, so 4 free, not 6.
    fx = next(f for p, f in BACKFILL if p.stem == "03-pending-holds-its-seat")
    assert fx["expect"]["state"] == {"cap": 8, "held": 4, "attending": 2, "pending": 2, "declined": 2, "available": 4}
    assert fx["expect"]["release"] == {"ids": ["b1", "b2"], "seats": 4, "reason": "ok"}


def test_headcount_matches_the_oracle_and_the_hand_math():
    fx = json.loads((guest_oracle.ROOT / "headcount.json").read_text())
    assert guest_oracle.headcount(fx) == fx["expect"]
    assert fx["expect"]["costCents"] == 4 * 8700 + 2 * 3500 + 2 * 4000 == 49800


# --- gifts: the pooled ledger (PRD P0-5) ------------------------------------------------------------------------------
import gift_oracle

GIFTS = gift_oracle.load()


def test_there_are_gift_fixtures():
    assert len(GIFTS) >= 12
    assert sum(1 for _, fx in GIFTS if fx.get("race")) >= 3


@pytest.mark.parametrize("path,fx", GIFTS, ids=[p.stem for p, _ in GIFTS])
def test_gift_expectations_match_the_oracle(path, fx):
    assert fx["expect"] == gift_oracle.expected(fx)
    assert path.read_text() == gift_oracle.dump(fx), "fixture is not in canonical JSON form"
    e = fx["expect"]
    # The ledger's own invariants, whatever the story: integer cents, a pot between zero and its target, nobody below
    # zero, a funded pot exactly on target, a closed one empty, and a thank-you for each household that gave to a funded gift.
    assert all(type(x["amountCents"]) is int and x["amountCents"] != 0 for x in e["entries"])
    assert all((x["amountCents"] > 0) == (x["kind"] == "contribution") for x in e["entries"])
    assert 0 <= e["potCents"] <= fx["targetCents"]
    assert e["potCents"] == sum(x["amountCents"] for x in e["entries"]) == sum(e["net"].values())
    assert all(n >= 0 for n in e["net"].values())
    assert (e["state"] == "funded") == (e["potCents"] == fx["targetCents"])
    if e["state"] == "closed_unfunded":
        assert e["potCents"] == 0 and all(n == 0 for n in e["net"].values())
    assert e["thankYous"] == (sorted(h for h, n in e["net"].items() if n > 0) if e["state"] == "funded" else [])


@pytest.mark.parametrize("path,fx", [(p, f) for p, f in GIFTS if f.get("race")], ids=[p.stem for p, f in GIFTS if f.get("race")])
def test_the_race_ends_exactly_on_target_in_every_order(path, fx):
    offered = sum(s["offerCents"] for s in fx["steps"])
    assert offered > fx["targetCents"], "a race fixture offers more than the target"
    for r in gift_oracle.orders(fx):
        assert r["state"] == "funded" and r["potCents"] == fx["targetCents"]
        taken = sum(x["amountCents"] for x in r["entries"] if x["kind"] == "contribution")
        back = -sum(x["amountCents"] for x in r["entries"] if x["kind"] == "excess_return")
        assert taken - back == fx["targetCents"]
        # A refused offer took nothing: every household with no entry is at zero, and nobody is owed anything.
        assert all(n >= 0 for n in r["net"].values())


def test_gift_race_by_hand():
    # Target 500.00, 300.00 in. Two households offer 250.00 each at once. First served: 250.00 in, 50.00 back. Second: refused.
    fx = next(f for p, f in GIFTS if p.stem == "04-race-both-complete")
    assert [s.get("lines") or s["code"] for s in fx["expect"]["steps"]] == [
        [{"kind": "contribution", "amountCents": 30000}],
        [{"kind": "contribution", "amountCents": 25000}, {"kind": "excess_return", "amountCents": -5000}],
        "funded",
    ]
    assert fx["expect"]["net"] == {"h1": 30000, "h2": 20000}
    assert fx["expect"]["thankYous"] == ["h1", "h2"]


def test_gift_close_by_hand():
    # h1 gave 100.00 and 50.00, h2 gave 150.00; at close each gets one refund of 150.00 and the pot is empty.
    fx = next(f for p, f in GIFTS if p.stem == "08-close-with-refunds")
    assert [x for x in fx["expect"]["entries"] if x["kind"] == "refund"] == [
        {"kind": "refund", "amountCents": -15000, "householdId": "h1"},
        {"kind": "refund", "amountCents": -15000, "householdId": "h2"},
    ]
    assert fx["expect"]["net"] == {"h1": 0, "h2": 0} and fx["expect"]["state"] == "closed_unfunded"
    assert fx["expect"]["steps"][-1] == {"ok": False, "code": "closed"}


# --- photos: upload limits and the moderation table (PRD P0-6) --------------------------------------------------------
import photo_limits

PHOTO_LIMITS = photo_limits.load()


def test_there_are_photo_limit_fixtures():
    assert len(PHOTO_LIMITS) >= 8
    seen = {k for _, fx in PHOTO_LIMITS for k in fx["expect"]["totals"]}
    assert seen == {"ok", "blocked", "device", "address", "event"}, "every outcome appears in some fixture"


@pytest.mark.parametrize("path,fx", PHOTO_LIMITS, ids=[p.stem for p, _ in PHOTO_LIMITS])
def test_photo_limit_expectations_match_the_oracle(path, fx):
    assert fx["expect"] == photo_limits.expected(fx)
    assert path.read_text() == photo_limits.dump(fx), "fixture is not in canonical JSON form"
    assert sum(fx["expect"]["totals"].values()) == fx["expect"]["attempts"] == sum(n for _, n in fx["expect"]["runs"])


def test_photo_load_case_by_hand():
    # 200 uploads, 20 devices taking turns, one every 3 seconds: 597 seconds, inside one 10-minute window. Each device
    # sends 10 (limit 30), the address carries 200 (limit 300), the event 200 (limit 1500 an hour). Nothing is refused.
    fx = next(f for p, f in PHOTO_LIMITS if p.stem == "03-load-200-from-20-devices")
    attempts = photo_limits.expand(fx["steps"])
    assert len(attempts) == 200 and len({a["device"] for a in attempts}) == 20 and attempts[-1]["t"] == 597 < 600
    assert "limits" not in fx, "the load case runs against the shipped limits"
    assert fx["expect"] == {"attempts": 200, "totals": {"ok": 200}, "runs": [["ok", 200]]}
    up = photo_limits.RULES["upload"]
    assert up["perDevice"]["limit"] >= 10 and up["perAddress"]["limit"] >= 200 and up["perEvent"]["limit"] >= 200


def test_photo_device_limit_by_hand():
    # One phone, 35 tries ten seconds apart (0..340 s), limit 30 per 10 minutes: 30 in, 5 refused; at 600 s a new window.
    fx = next(f for p, f in PHOTO_LIMITS if p.stem == "02-one-device-over")
    assert fx["expect"]["runs"] == [["ok", 30], ["device", 5], ["ok", 1]]


def test_photo_moderation_table_matches_the_oracle():
    fx = json.loads(photo_limits.MODERATION.read_text())
    assert fx["initial"] == photo_limits.INITIAL
    assert len(fx["moves"]) == 2 * 4 * 4 * 2  # mode x state x action x purged
    assert len({json.dumps([m["mode"], m["state"], m["action"], m["purged"]]) for m in fx["moves"]}) == len(fx["moves"])
    for m in fx["moves"]:
        assert m["expect"] == photo_limits.move(m["state"], m["action"], m["purged"]), m
    assert len(fx["visibility"]) == 3 * 2 * 2 * 2
    for v in fx["visibility"]:
        assert (v["wall"], v["album"]) == photo_limits.visible(v), v
    # Takedown then undo is the identity, and so is reject then undo.
    for state, first in ((("live", None), "take_down"), (("pending", None), "reject")):
        s = {"status": state[0], "removedFrom": state[1]}
        down = photo_limits.move(s, first, False)["next"]
        assert down["status"] == "removed" and photo_limits.move(down, "undo", False)["next"] == s


# --- funding: the multi-funder family budget (P1-2) --------------------------------------------------------------------
import funding_oracle

FUNDING = funding_oracle.load()


def test_there_are_funding_fixtures():
    assert len(FUNDING) >= 9
    codes = {s.get("code") for _, fx in FUNDING for s in fx["expect"]["steps"]}
    # Every refusal the engine has is exercised by some fixture.
    assert codes >= {"amount", "duplicate", "unknown", "below-received", "over-pledge", "spent", "wrong-category", "over-received", "over-expense"}


@pytest.mark.parametrize("path,fx", FUNDING, ids=[p.stem for p, _ in FUNDING])
def test_funding_expectations_match_the_oracle(path, fx):
    assert fx["expect"] == funding_oracle.expected(fx)
    assert path.read_text() == funding_oracle.dump(fx), "fixture is not in canonical JSON form"
    # The invariants, whatever the story: integer cents, pledged >= received >= spent >= 0, and a category's mix is the
    # sum of its pledges.
    for p in fx["expect"]["pledges"]:
        assert all(type(p[k]) is int for k in ("pledgedCents", "receivedCents", "spentCents", "outstandingCents", "unspentCents"))
        assert p["pledgedCents"] >= p["receivedCents"] >= p["spentCents"] >= 0
        assert p["outstandingCents"] == p["pledgedCents"] - p["receivedCents"]
        assert p["unspentCents"] == p["receivedCents"] - p["spentCents"]
    for c in fx["expect"]["categories"]:
        for k in ("pledgedCents", "receivedCents", "spentCents"):
            assert c[k] == sum(p[k] for p in c["pledges"])


def test_funding_two_funders_by_hand():
    # A $10,000.00 venue spend: the Vales pay $7,000.00, the Ashbys $3,000.00 (a cent more is refused); the couple pays nothing more.
    fx = next(f for p, f in FUNDING if p.stem == "05-two-funders-one-spend")
    assert [s.get("code", "ok") for s in fx["expect"]["steps"]][-2:] == ["over-expense", "ok"]
    venue = fx["expect"]["categories"][0]
    assert (venue["pledgedCents"], venue["receivedCents"], venue["spentCents"]) == (1_200_000, 1_200_000, 1_000_000)


# --- thanks: the thank-you obligation ledger's aging (P1-3) ------------------------------------------------------------
import thanks_oracle

THANKS = thanks_oracle.load()


def test_there_are_thanks_fixtures():
    assert len(THANKS) >= 7
    buckets = {o["bucket"] for _, fx in THANKS for o in fx["expect"]["owed"]}
    assert buckets == {"fresh", "weeks", "late", "later"}
    assert {o["source"] for _, fx in THANKS for o in fx["obligations"]} == {"pooled", "claimed", "logged"}


@pytest.mark.parametrize("path,fx", THANKS, ids=[p.stem for p, _ in THANKS])
def test_thanks_expectations_match_the_oracle(path, fx):
    assert fx["expect"] == thanks_oracle.expected(fx)
    assert path.read_text() == thanks_oracle.dump(fx), "fixture is not in canonical JSON form"
    e = fx["expect"]
    # Whatever the story: every obligation is either owed or thanked, the buckets add up to what is owed, no age is
    # negative, and nothing in the ledger is an amount of money.
    assert len(e["owed"]) + len(e["thanked"]) == e["total"] == len(fx["obligations"])
    assert sum(b["count"] for b in e["buckets"]) == len(e["owed"])
    assert all(o["ageDays"] >= 0 for o in e["owed"])
    assert e["overdue"] == sum(1 for o in e["owed"] if o["ageDays"] > 21)
    assert not any("cents" in k.lower() or "amount" in k.lower() for o in fx["obligations"] for k in o)


def test_thanks_the_prd_headline_by_hand():
    fx = next(f for p, f in THANKS if p.stem == "05-fourteen-unthanked")
    assert fx["expect"]["headline"] == "14 unthanked > 3 weeks"
    # The bucket edges: 6 days is under a week, 7 is not; 21 is not "over 3 weeks", 22 is; 42 is "3 to 6", 43 is over 6.
    edges = next(f for p, f in THANKS if p.stem == "02-bucket-edges")["expect"]["owed"]
    assert [(o["ageDays"], o["bucket"], o["overdue"]) for o in edges] == [(43, "later", True), (42, "late", True), (22, "late", True), (21, "weeks", False), (7, "weeks", False), (6, "fresh", False), (0, "fresh", False)]


# --- namechange: the name-change sequence's order and gating (P1-4) ----------------------------------------------------
import namechange_oracle

NAME_RULES = namechange_oracle.load_rules()
NAME_FIXTURES = namechange_oracle.load()


def test_the_rules_files_are_in_an_order_that_works():
    assert set(NAME_RULES) == {"generic", "us-ca", "us-ny", "us-tx"}
    assert [k for k, r in NAME_RULES.items() if r["fallback"]] == ["generic"]
    for key, r in NAME_RULES.items():
        assert r["jurisdiction"] == key
        assert namechange_oracle.rule_problems(r) == [], key
        # The PRD's order: federal first, accounts last.
        assert r["steps"][0]["phase"] == "federal" and r["steps"][-1]["phase"] == "accounts", key
        # Illustrative content: no money and no claim about how long anything takes.
        text = json.dumps(r).lower()
        assert "$" not in text and "fee" not in text.replace("fees or waiting times", ""), key
        assert "business day" not in text and "weeks" not in text, key


def test_the_oracle_catches_a_broken_order():
    r = json.loads(json.dumps(NAME_RULES["generic"]))
    r["steps"].insert(0, r["steps"].pop(1))  # the state step before the federal one it waits for
    problems = namechange_oracle.rule_problems(r)
    assert any("not earlier" in p for p in problems) and any("phase goes backwards" in p for p in problems)


def test_there_are_namechange_fixtures():
    assert len(NAME_FIXTURES) >= 8
    codes = {o["code"] for _, fx in NAME_FIXTURES for o in fx["expect"]["outcomes"] if not o["ok"]}
    assert {"prerequisites", "artifacts", "not-produced", "produced-held", "dependents", "in-use"} <= codes
    assert {fx["rules"] for _, fx in NAME_FIXTURES} >= {"generic", "us-ca", "us-ny"}


@pytest.mark.parametrize("path,fx", NAME_FIXTURES, ids=[p.stem for p, _ in NAME_FIXTURES])
def test_namechange_expectations_match_the_oracle(path, fx):
    assert fx["expect"] == namechange_oracle.expected(fx, NAME_RULES)
    assert path.read_text() == namechange_oracle.dump(fx), "fixture is not in canonical JSON form"
    # Whatever the story, the gating's three facts hold where it ends.
    assert fx["expect"]["invariants"] == []


def test_namechange_gating_by_hand():
    # Nothing held, nothing done: the federal step is refused for both documents, and nothing can start.
    r = NAME_RULES["generic"]
    assert namechange_oracle.answer(r, {}, set(), "start", "ssa") == {"ok": False, "code": "artifacts", "keys": ["marriage-certificate", "proof-of-identity"]}
    assert namechange_oracle.answer(r, {}, {"marriage-certificate", "proof-of-identity"}, "start", "dmv") == {"ok": False, "code": "prerequisites", "keys": ["ssa"]}
