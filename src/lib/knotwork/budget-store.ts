// Budget writes and reads. The ONLY place an Expense row is created: over the threshold it must carry the approved
// request that allowed it (rule 2; the database checks the same thing in the Expense_guard trigger).
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import type { Prisma } from '@/generated/prisma/client';
import { rollup, type Rollup } from './budget';
import { logChange } from './changelog';
import type { WeddingRow } from './context';
import { spendNeedsConsent } from './consent/machine';
import { dbOfDay, type Day } from './days';
import { usd } from './money';

type Ctx = { orgId: string; userId: string | null };
export type ExpenseInput = { categoryId: string; vendorId: string | null; description: string; amountCents: number; paidOn: Day; paymentId: string | null };

/** Writes the expense and, when it pays a scheduled vendor payment, marks that payment paid and its task done. */
export async function createExpense(tx: Tx, ctx: Ctx, wedding: WeddingRow, input: ExpenseInput, requestId: string | null) {
  if (spendNeedsConsent(input.amountCents, wedding.spendThresholdCents) && !requestId) throw new Error('two-key: a spend over the threshold needs an approved request');
  const category = await tx.budgetCategory.findFirstOrThrow({ where: { id: input.categoryId, ...inOrg(ctx) }, select: { name: true } });
  const expense = await tx.expense.create({
    data: { orgId: ctx.orgId, categoryId: input.categoryId, vendorId: input.vendorId, description: input.description, amountCents: input.amountCents, paidOn: dbOfDay(input.paidOn), requestId, createdById: ctx.userId },
  });
  await logChange(tx, ctx, 'expense', 'created', expense.id, `${input.description} (${category.name})`, null, { amountCents: input.amountCents, amount: usd(input.amountCents), category: category.name, paidOn: input.paidOn, twoKey: !!requestId });
  if (input.paymentId) {
    const p = await tx.vendorPayment.findFirstOrThrow({ where: { id: input.paymentId, ...inOrg(ctx) } });
    await tx.vendorPayment.update({ where: { id: p.id }, data: { paidOn: dbOfDay(input.paidOn), expenseId: expense.id } });
    await tx.task.update({ where: { id: p.taskId }, data: { status: 'done', completedOn: dbOfDay(input.paidOn) } });
    await logChange(tx, ctx, 'payment', 'paid', p.id, p.label, { paidOn: null }, { paidOn: input.paidOn, amountCents: p.amountCents });
  }
  return expense;
}

export async function loadBudget(tx: Tx, ctx: { orgId: string }): Promise<Rollup> {
  // One at a time: a transaction has one connection.
  const categories = await tx.budgetCategory.findMany({ where: inOrg(ctx), select: { id: true, name: true, estimateCents: true } });
  const expenses = await tx.expense.findMany({ where: inOrg(ctx), select: { categoryId: true, amountCents: true } });
  return rollup(categories, expenses);
}

/** PRD P0-7 "snapshots": the rollup as it is now, frozen. */
export async function takeSnapshot(tx: Tx, ctx: Ctx, note: string) {
  const totals = await loadBudget(tx, ctx);
  const s = await tx.budgetSnapshot.create({ data: { orgId: ctx.orgId, note, totals: totals as unknown as Prisma.InputJsonObject, takenById: ctx.userId } });
  await logChange(tx, ctx, 'snapshot', 'taken', s.id, note || 'Budget snapshot', null, { estimateCents: totals.estimateCents, actualCents: totals.actualCents });
  return s;
}
