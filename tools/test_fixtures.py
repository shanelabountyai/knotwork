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
