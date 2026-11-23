"""Estimate-vs-actual rollup as plain integer sums (Python standard library only). Independent of src/lib/knotwork/budget.ts."""
from __future__ import annotations


def rollup(categories: list[dict], expenses: list[dict]) -> dict:
    lines = []
    for c in sorted(categories, key=lambda c: c["name"]):
        actual = sum(e["amountCents"] for e in expenses if e["categoryId"] == c["id"])
        lines.append({"id": c["id"], "name": c["name"], "estimateCents": c["estimateCents"], "actualCents": actual, "remainingCents": c["estimateCents"] - actual, "over": actual > c["estimateCents"]})
    estimate, actual = sum(c["estimateCents"] for c in categories), sum(e["amountCents"] for e in expenses)
    return {"lines": lines, "estimateCents": estimate, "actualCents": actual, "remainingCents": estimate - actual, "over": actual > estimate}
