// P1-2, the multi-funder family budget, in the database: funders, pledges, money received, money spent. A store;
// everything runs inside the caller's withOrg transaction and every write is logged in it. The arithmetic is
// funding/ledger.ts; the database re-checks the sums at commit.
//
// CONTRIBUTOR-SCOPED VISIBILITY: `fundingView` is the only reader the funding page has. A partner, or a helper with a
// budget grant, sees every funder. A helper holding only the `funder` grant sees the one funder linked to them: the
// categories that funder pledged toward (by name), their pledges, what was received and what was spent from them.
// No category estimate, no other funder, no expense that their money did not pay. Secrecy (P1-1) applies on top: a
// pledge toward a hidden category, and a payment toward a hidden spend, are masked lines.
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { allows, type Who } from '../access';
import { logChange } from '../changelog';
import { dayOfDb, dbOfDay, type Day } from '../days';
import { usd } from '../money';
import { lens, type Lensed } from '../secrecy/lens';
import type { Seen } from '../secrecy/compartment';
import { checkAllocation, checkPledge, checkReceipt, checkUnreceive, FUNDING_PROBLEM, pledgeLines, type PledgeLine } from './ledger';

type Ctx = { orgId: string; userId: string | null };
const refuse = (code: keyof typeof FUNDING_PROBLEM): never => {
  throw new Refused(FUNDING_PROBLEM[code]);
};

/** Serialises every write to one pledge (the database checks the sums again at commit). */
const lockPledge = (tx: Tx, id: string) => tx.$queryRaw`SELECT 1 FROM "FunderPledge" WHERE id = ${id}::uuid FOR UPDATE`;

async function lineOf(tx: Tx, ctx: { orgId: string }, pledgeId: string): Promise<PledgeLine> {
  const p = await tx.funderPledge.findFirstOrThrow({ where: { id: pledgeId, ...inOrg(ctx) } });
  const receipts = await tx.funderReceipt.findMany({ where: { pledgeId, ...inOrg(ctx) }, select: { id: true, pledgeId: true, amountCents: true } });
  const allocations = await tx.funderAllocation.findMany({ where: { pledgeId, ...inOrg(ctx) }, select: { id: true, pledgeId: true, expenseId: true, amountCents: true } });
  return pledgeLines([p], receipts, allocations)[0]!;
}
const pledgeLabel = (tx: Tx, ctx: { orgId: string }, id: string) =>
  tx.funderPledge.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { funder: { select: { name: true } }, category: { select: { name: true } } } }).then((p) => `${p.funder.name}: ${p.category.name}`);

export async function addFunder(tx: Tx, ctx: Ctx, name: string, note: string) {
  if (await tx.funder.findFirst({ where: { ...inOrg(ctx), name }, select: { id: true } })) throw new Refused(`There is already a funder called ${name}.`);
  const f = await tx.funder.create({ data: { orgId: ctx.orgId, name, note, createdById: ctx.userId } });
  await logChange(tx, ctx, 'funder', 'created', f.id, f.name, null, { name, note });
  return f;
}

/**
 * Links a helper to a funder: the `funder` grant, and the funder's userId. A person is linked to one funder at most,
 * and a funder to one person. The caller has proved both are in this workspace and that the person is not a partner.
 */
export async function linkFunder(tx: Tx, ctx: Ctx, funderId: string, userId: string, email: string) {
  const f = await tx.funder.findFirstOrThrow({ where: { id: funderId, ...inOrg(ctx) } });
  if (f.userId === userId) throw new Refused('They are already linked to that funder.');
  if (f.userId) throw new Refused('That funder is already linked to someone. Unlink them first.');
  if (await tx.funder.findFirst({ where: { ...inOrg(ctx), userId }, select: { id: true } })) throw new Refused('That person is already linked to another funder.');
  await tx.funder.update({ where: { id: f.id }, data: { userId } });
  await logChange(tx, ctx, 'funder', 'linked', f.id, f.name, { userId: null }, { userId });
  if (!(await tx.helperGrant.findFirst({ where: { ...inOrg(ctx), userId, scope: 'funder' }, select: { id: true } }))) {
    const g = await tx.helperGrant.create({ data: { orgId: ctx.orgId, userId, scope: 'funder', grantedById: ctx.userId } });
    await logChange(tx, ctx, 'grant', 'granted', g.id, `${email}: funder (${f.name})`, null, { userId, scope: 'funder' });
  }
}

/** Ends a link: the funder's userId and the person's `funder` grant. Also called when the grant is revoked. */
export async function unlinkFunder(tx: Tx, ctx: Ctx, funderId: string) {
  const f = await tx.funder.findFirstOrThrow({ where: { id: funderId, ...inOrg(ctx) } });
  if (!f.userId) throw new Refused('Nobody is linked to that funder.');
  await tx.funder.update({ where: { id: f.id }, data: { userId: null } });
  await logChange(tx, ctx, 'funder', 'unlinked', f.id, f.name, { userId: f.userId }, { userId: null });
  for (const g of await tx.helperGrant.findMany({ where: { ...inOrg(ctx), userId: f.userId, scope: 'funder' } })) {
    await tx.helperGrant.delete({ where: { id: g.id } });
    await logChange(tx, ctx, 'grant', 'revoked', g.id, `funder (${f.name})`, { userId: g.userId, scope: g.scope }, null);
  }
}

export async function addPledge(tx: Tx, ctx: Ctx, funderId: string, categoryId: string, amountCents: number) {
  if (checkPledge(amountCents)) refuse('amount');
  if (await tx.funderPledge.findFirst({ where: { ...inOrg(ctx), funderId, categoryId }, select: { id: true } })) refuse('duplicate');
  const p = await tx.funderPledge.create({ data: { orgId: ctx.orgId, funderId, categoryId, amountCents, createdById: ctx.userId } });
  await logChange(tx, ctx, 'pledge', 'created', p.id, await pledgeLabel(tx, ctx, p.id), null, { amountCents, amount: usd(amountCents) });
  return p;
}

export async function changePledge(tx: Tx, ctx: Ctx, pledgeId: string, amountCents: number) {
  await lockPledge(tx, pledgeId);
  const line = await lineOf(tx, ctx, pledgeId);
  const bad = checkPledge(amountCents, line);
  if (bad) refuse(bad);
  await tx.funderPledge.update({ where: { id: pledgeId }, data: { amountCents } });
  await logChange(tx, ctx, 'pledge', 'updated', pledgeId, await pledgeLabel(tx, ctx, pledgeId), { amountCents: line.pledgedCents }, { amountCents });
}

export async function receive(tx: Tx, ctx: Ctx, pledgeId: string, amountCents: number, receivedOn: Day, note: string) {
  await lockPledge(tx, pledgeId);
  const bad = checkReceipt(await lineOf(tx, ctx, pledgeId), amountCents);
  if (bad) refuse(bad);
  const r = await tx.funderReceipt.create({ data: { orgId: ctx.orgId, pledgeId, amountCents, receivedOn: dbOfDay(receivedOn), note, createdById: ctx.userId } });
  await logChange(tx, ctx, 'receipt', 'created', r.id, await pledgeLabel(tx, ctx, pledgeId), null, { amountCents, amount: usd(amountCents), receivedOn, note });
  return r;
}

export async function removeReceipt(tx: Tx, ctx: Ctx, receiptId: string) {
  const r = await tx.funderReceipt.findFirstOrThrow({ where: { id: receiptId, ...inOrg(ctx) } });
  await lockPledge(tx, r.pledgeId);
  if (checkUnreceive(await lineOf(tx, ctx, r.pledgeId), r.amountCents)) refuse('spent');
  // Logged first: the entry's privacy is read from the row, which is about to go.
  await logChange(tx, ctx, 'receipt', 'deleted', r.id, await pledgeLabel(tx, ctx, r.pledgeId), { amountCents: r.amountCents, receivedOn: dayOfDb(r.receivedOn) }, null);
  await tx.funderReceipt.delete({ where: { id: r.id } });
}

export async function allocate(tx: Tx, ctx: Ctx, pledgeId: string, expenseId: string, amountCents: number) {
  await lockPledge(tx, pledgeId);
  await tx.$queryRaw`SELECT 1 FROM "Expense" WHERE id = ${expenseId}::uuid FOR UPDATE`;
  const line = await lineOf(tx, ctx, pledgeId);
  const e = await tx.expense.findFirstOrThrow({ where: { id: expenseId, ...inOrg(ctx) }, select: { id: true, categoryId: true, amountCents: true, description: true } });
  if (await tx.funderAllocation.findFirst({ where: { ...inOrg(ctx), pledgeId, expenseId }, select: { id: true } })) refuse('duplicate');
  const paid = (await tx.funderAllocation.aggregate({ where: { ...inOrg(ctx), expenseId }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const bad = checkAllocation(line, e, paid, amountCents);
  if (bad) refuse(bad);
  const a = await tx.funderAllocation.create({ data: { orgId: ctx.orgId, pledgeId, expenseId, amountCents, createdById: ctx.userId } });
  const funder = await tx.funderPledge.findFirstOrThrow({ where: { id: pledgeId }, select: { funder: { select: { name: true } } } });
  await logChange(tx, ctx, 'allocation', 'created', a.id, `${funder.funder.name}: ${e.description}`, null, { amountCents, amount: usd(amountCents) });
  return a;
}

export async function removeAllocation(tx: Tx, ctx: Ctx, allocationId: string) {
  const a = await tx.funderAllocation.findFirstOrThrow({ where: { id: allocationId, ...inOrg(ctx) }, include: { pledge: { select: { funder: { select: { name: true } } } }, expense: { select: { description: true } } } });
  await logChange(tx, ctx, 'allocation', 'deleted', a.id, `${a.pledge.funder.name}: ${a.expense.description}`, { amountCents: a.amountCents }, null);
  await tx.funderAllocation.delete({ where: { id: a.id } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

const C = { privateToId: true, revealDays: true } as const;
async function rows(tx: Tx, ctx: { orgId: string }, funderWhere: { userId?: string } = {}) {
  const funders = await tx.funder.findMany({ where: { ...inOrg(ctx), ...funderWhere }, orderBy: { name: 'asc' } });
  const ids = funders.map((f) => f.id);
  const pledges = await tx.funderPledge.findMany({ where: { ...inOrg(ctx), funderId: { in: ids } }, include: { category: { select: { id: true, name: true, ...C } } }, orderBy: { createdAt: 'asc' } });
  const pledgeIds = pledges.map((p) => p.id);
  const receipts = await tx.funderReceipt.findMany({ where: { ...inOrg(ctx), pledgeId: { in: pledgeIds } }, orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }] });
  const allocations = await tx.funderAllocation.findMany({
    where: { ...inOrg(ctx), pledgeId: { in: pledgeIds } },
    include: { expense: { select: { id: true, description: true, paidOn: true, amountCents: true, ...C, category: { select: C }, vendor: { select: C } } } },
    orderBy: { createdAt: 'asc' },
  });
  return { funders, pledges, receipts, allocations };
}

export type Paid = { id: string; amountCents: number; description: string; paidOn: Day };
export type PledgeView = { id: string; categoryId: string; categoryName: string; line: PledgeLine; receipts: { id: string; amountCents: number; receivedOn: Day; note: string }[]; paid: Lensed<Paid>[] };
export type FunderView = { id: string; name: string; note: string; userId: string | null; pledgedCents: number; receivedCents: number; spentCents: number; pledges: Lensed<PledgeView>[] };

/**
 * The funding page's data, scoped to the viewer: every funder, or (a helper with only the `funder` grant) the one
 * linked to them; null when they may see neither. Hidden categories and spends come out masked; their amounts still
 * count in each funder's totals.
 */
export async function fundingView(tx: Tx, ctx: { orgId: string; userId: string }, who: Who, seen: Seen): Promise<{ scope: 'all' | 'own'; funders: FunderView[] } | null> {
  const scope = allows(who, 'budget.view') ? 'all' : who.grants.includes('funder') ? 'own' : null;
  if (!scope) return null;
  const r = await rows(tx, ctx, scope === 'own' ? { userId: ctx.userId } : {});
  const L = lens(seen);
  const lines = new Map(pledgeLines(r.pledges, r.receipts, r.allocations).map((l) => [l.pledgeId, l]));
  const funders = r.funders.map((f) => {
    const mine = r.pledges.filter((p) => p.funderId === f.id);
    const total = (k: 'pledgedCents' | 'receivedCents' | 'spentCents') => mine.reduce((n, p) => n + lines.get(p.id)![k], 0);
    const pledges = mine.map((p) => L.ofCategory<PledgeView>({
      id: p.id, categoryId: p.categoryId, categoryName: p.category.name, line: lines.get(p.id)!,
      receipts: r.receipts.filter((x) => x.pledgeId === p.id).map((x) => ({ id: x.id, amountCents: x.amountCents, receivedOn: dayOfDb(x.receivedOn), note: x.note })),
      paid: r.allocations.filter((a) => a.pledgeId === p.id).map((a) => L.expense({ ...a.expense, id: a.id, amountCents: a.amountCents, paidOn: dayOfDb(a.expense.paidOn) })).map((x) => (x.hidden ? x : { ...x, row: { id: x.row.id, amountCents: x.row.amountCents, description: x.row.description, paidOn: x.row.paidOn } })),
    }, p.category));
    return { id: f.id, name: f.name, note: f.note, userId: scope === 'all' ? f.userId : null, pledgedCents: total('pledgedCents'), receivedCents: total('receivedCents'), spentCents: total('spentCents'), pledges };
  });
  return { scope, funders };
}

/** Each category's funding, for the budget page: category id → its pledges' totals and who pledged. Budget viewers only. */
export async function fundingByCategory(tx: Tx, ctx: { orgId: string }) {
  const r = await rows(tx, ctx);
  const lines = pledgeLines(r.pledges, r.receipts, r.allocations);
  const name = new Map(r.funders.map((f) => [f.id, f.name]));
  const out = new Map<string, { funder: string; line: PledgeLine }[]>();
  for (const l of lines) out.set(l.categoryId, [...(out.get(l.categoryId) ?? []), { funder: name.get(l.funderId)!, line: l }]);
  for (const v of out.values()) v.sort((a, b) => a.funder.localeCompare(b.funder));
  return out;
}
