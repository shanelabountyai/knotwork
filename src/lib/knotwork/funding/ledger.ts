// P1-2, the multi-funder family budget: the pledge arithmetic. PURE. Integer cents in, integer cents out.
//
// A funder pledges an amount toward one budget category. Money then arrives against the pledge (received, possibly in
// parts, each on a day of fact), and received money is spent: part of an expense in that category is paid from the
// pledge (an allocation). Per pledge, always: pledged >= received >= spent >= 0. Per expense: what the pledges paid
// is at most its amount. The database checks the same sums at commit (20261126000000_knotwork_secrecy_funders);
// tools/funding_oracle.py recomputes fixtures/funding/ independently.

export const PLEDGE_MIN_CENTS = 100; // $1.00
export const PLEDGE_MAX_CENTS = 100_000_000; // $1,000,000.00 (D-95)

export type Pledge = { id: string; funderId: string; categoryId: string; amountCents: number };
export type Receipt = { id: string; pledgeId: string; amountCents: number };
export type Allocation = { id: string; pledgeId: string; expenseId: string; amountCents: number };
export type ExpenseRef = { id: string; categoryId: string; amountCents: number };

export type Stage = 'pledged' | 'partly_received' | 'received' | 'spent';
export type PledgeLine = { pledgeId: string; funderId: string; categoryId: string; pledgedCents: number; receivedCents: number; spentCents: number; outstandingCents: number; unspentCents: number; stage: Stage };
export type CategoryMix = { categoryId: string; pledgedCents: number; receivedCents: number; spentCents: number; pledges: PledgeLine[] };

const cents = (n: number) => {
  if (!Number.isInteger(n)) throw new Error('money is integer cents');
  return n;
};
const sumBy = <T>(rows: readonly T[], key: (r: T) => string, amount: (r: T) => number) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + cents(amount(r)));
  return m;
};

/** pledged → partly received → received (all of it) → spent (all of it). */
export function stageOf(pledged: number, received: number, spent: number): Stage {
  if (received === 0) return 'pledged';
  if (received < pledged) return 'partly_received';
  return spent >= pledged ? 'spent' : 'received';
}

/** One line per pledge, in id order. */
export function pledgeLines(pledges: readonly Pledge[], receipts: readonly Receipt[], allocations: readonly Allocation[]): PledgeLine[] {
  const got = sumBy(receipts, (r) => r.pledgeId, (r) => r.amountCents);
  const spent = sumBy(allocations, (a) => a.pledgeId, (a) => a.amountCents);
  return [...pledges]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => {
      const [pledgedCents, receivedCents, spentCents] = [cents(p.amountCents), got.get(p.id) ?? 0, spent.get(p.id) ?? 0];
      return { pledgeId: p.id, funderId: p.funderId, categoryId: p.categoryId, pledgedCents, receivedCents, spentCents, outstandingCents: pledgedCents - receivedCents, unspentCents: receivedCents - spentCents, stage: stageOf(pledgedCents, receivedCents, spentCents) };
    });
}

/** Each category's funding mix: who pledged what toward it, in category id order. */
export function categoryMix(lines: readonly PledgeLine[]): CategoryMix[] {
  const by = new Map<string, PledgeLine[]>();
  for (const l of lines) by.set(l.categoryId, [...(by.get(l.categoryId) ?? []), l]);
  return [...by.keys()].sort().map((categoryId) => {
    const ps = by.get(categoryId)!;
    const total = (k: 'pledgedCents' | 'receivedCents' | 'spentCents') => ps.reduce((n, p) => n + p[k], 0);
    return { categoryId, pledgedCents: total('pledgedCents'), receivedCents: total('receivedCents'), spentCents: total('spentCents'), pledges: ps };
  });
}

export type Problem = 'amount' | 'duplicate' | 'unknown' | 'below-received' | 'over-pledge' | 'spent' | 'wrong-category' | 'over-received' | 'over-expense';
export const FUNDING_PROBLEM: Record<Problem, string> = {
  amount: 'An amount from $1.00 to $1,000,000.00, please.',
  duplicate: 'That is already there. Change the one you have instead.',
  unknown: 'That is not there any more.',
  'below-received': 'A pledge cannot be less than what has already been received against it.',
  'over-pledge': 'That is more than is left of the pledge. Raise the pledge first.',
  spent: 'Some of that money has already been spent. Remove what was paid from it first.',
  'wrong-category': 'A pledge pays only for spends in its own budget category.',
  'over-received': 'That is more than has been received and not yet spent from this pledge.',
  'over-expense': 'That is more than is left of the spend to pay.',
};
const okAmount = (n: number) => Number.isInteger(n) && n >= PLEDGE_MIN_CENTS && n <= PLEDGE_MAX_CENTS;
const okPart = (n: number) => Number.isInteger(n) && n >= 1 && n <= PLEDGE_MAX_CENTS;

/** A new pledge, or a change to one: at least what was received. */
export const checkPledge = (amount: number, line?: PledgeLine): Problem | null => (!okAmount(amount) ? 'amount' : line && amount < line.receivedCents ? 'below-received' : null);
/** Money received: at most what is left of the pledge. */
export const checkReceipt = (line: PledgeLine, amount: number): Problem | null => (!okPart(amount) ? 'amount' : amount > line.outstandingCents ? 'over-pledge' : null);
/** Taking a receipt back: what remains received must still cover what was spent. */
export const checkUnreceive = (line: PledgeLine, amount: number): Problem | null => (line.receivedCents - amount < line.spentCents ? 'spent' : null);
/** Paying part of an expense from a pledge: same category, within what is received and unspent, within what the expense has left to pay. */
export function checkAllocation(line: PledgeLine, expense: ExpenseRef, paidFromPledges: number, amount: number): Problem | null {
  if (!okPart(amount)) return 'amount';
  if (expense.categoryId !== line.categoryId) return 'wrong-category';
  if (amount > line.unspentCents) return 'over-received';
  if (paidFromPledges + amount > expense.amountCents) return 'over-expense';
  return null;
}

// ---- the replay the fixtures are written against (scripts/knotwork/gen-fixtures.ts, tools/funding_oracle.py).
export type Step =
  | { op: 'expense'; id: string; category: string; amountCents: number }
  | { op: 'pledge'; id: string; funder: string; category: string; amountCents: number }
  | { op: 'repledge'; pledge: string; amountCents: number }
  | { op: 'receive'; id: string; pledge: string; amountCents: number }
  | { op: 'unreceive'; receipt: string }
  | { op: 'spend'; id: string; pledge: string; expense: string; amountCents: number }
  | { op: 'unspend'; allocation: string };
export type Outcome = { ok: true } | { ok: false; code: Problem };

export function replay(steps: readonly Step[]): { steps: Outcome[]; pledges: PledgeLine[]; categories: CategoryMix[] } {
  const pledges: Pledge[] = [];
  const receipts: Receipt[] = [];
  const allocations: Allocation[] = [];
  const expenses: ExpenseRef[] = [];
  const out: Outcome[] = [];
  const lineOf = (id: string) => pledgeLines(pledges, receipts, allocations).find((l) => l.pledgeId === id);
  const refuse = (code: Problem) => out.push({ ok: false, code });
  for (const s of steps) {
    switch (s.op) {
      case 'expense':
        expenses.push({ id: s.id, categoryId: s.category, amountCents: s.amountCents });
        out.push({ ok: true });
        break;
      case 'pledge': {
        const bad = checkPledge(s.amountCents) ?? (pledges.some((p) => p.funderId === s.funder && p.categoryId === s.category) ? 'duplicate' : null);
        if (bad) refuse(bad);
        else {
          pledges.push({ id: s.id, funderId: s.funder, categoryId: s.category, amountCents: s.amountCents });
          out.push({ ok: true });
        }
        break;
      }
      case 'repledge': {
        const line = lineOf(s.pledge);
        const bad = line ? checkPledge(s.amountCents, line) : 'unknown';
        if (bad) refuse(bad);
        else {
          pledges.find((p) => p.id === s.pledge)!.amountCents = s.amountCents;
          out.push({ ok: true });
        }
        break;
      }
      case 'receive': {
        const line = lineOf(s.pledge);
        const bad = line ? checkReceipt(line, s.amountCents) : 'unknown';
        if (bad) refuse(bad);
        else {
          receipts.push({ id: s.id, pledgeId: s.pledge, amountCents: s.amountCents });
          out.push({ ok: true });
        }
        break;
      }
      case 'unreceive': {
        const at = receipts.findIndex((r) => r.id === s.receipt);
        const bad = at < 0 ? 'unknown' : checkUnreceive(lineOf(receipts[at]!.pledgeId)!, receipts[at]!.amountCents);
        if (bad) refuse(bad);
        else {
          receipts.splice(at, 1);
          out.push({ ok: true });
        }
        break;
      }
      case 'spend': {
        const line = lineOf(s.pledge);
        const expense = expenses.find((e) => e.id === s.expense);
        const paid = allocations.filter((a) => a.expenseId === s.expense).reduce((n, a) => n + a.amountCents, 0);
        const bad = !line || !expense ? 'unknown' : allocations.some((a) => a.pledgeId === s.pledge && a.expenseId === s.expense) ? 'duplicate' : checkAllocation(line, expense, paid, s.amountCents);
        if (bad) refuse(bad);
        else {
          allocations.push({ id: s.id, pledgeId: s.pledge, expenseId: s.expense, amountCents: s.amountCents });
          out.push({ ok: true });
        }
        break;
      }
      case 'unspend': {
        const at = allocations.findIndex((a) => a.id === s.allocation);
        if (at < 0) refuse('unknown');
        else {
          allocations.splice(at, 1);
          out.push({ ok: true });
        }
        break;
      }
    }
  }
  const lines = pledgeLines(pledges, receipts, allocations);
  return { steps: out, pledges: lines, categories: categoryMix(lines) };
}
