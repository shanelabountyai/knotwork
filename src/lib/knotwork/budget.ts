// Estimates vs actuals (PRD P0-7). PURE. Integer cents in, integer cents out.

export type CategoryIn = { id: string; name: string; estimateCents: number };
export type ExpenseIn = { categoryId: string; amountCents: number };
export type CategoryLine = { id: string; name: string; estimateCents: number; actualCents: number; remainingCents: number; over: boolean };
export type Rollup = { lines: CategoryLine[]; estimateCents: number; actualCents: number; remainingCents: number; over: boolean };

/** One line per category in name order, then the totals. `remaining` is negative when a category is over. */
export function rollup(categories: readonly CategoryIn[], expenses: readonly ExpenseIn[]): Rollup {
  const spent = new Map<string, number>();
  for (const e of expenses) {
    if (!Number.isInteger(e.amountCents)) throw new Error('money is integer cents');
    spent.set(e.categoryId, (spent.get(e.categoryId) ?? 0) + e.amountCents);
  }
  const known = new Set(categories.map((c) => c.id));
  for (const id of spent.keys()) if (!known.has(id)) throw new Error(`expense in unknown category ${id}`);
  const lines = [...categories]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => {
      const actualCents = spent.get(c.id) ?? 0;
      return { id: c.id, name: c.name, estimateCents: c.estimateCents, actualCents, remainingCents: c.estimateCents - actualCents, over: actualCents > c.estimateCents };
    });
  const estimateCents = lines.reduce((n, l) => n + l.estimateCents, 0);
  const actualCents = lines.reduce((n, l) => n + l.actualCents, 0);
  return { lines, estimateCents, actualCents, remainingCents: estimateCents - actualCents, over: actualCents > estimateCents };
}
