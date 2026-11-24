'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { GRANT_SCOPES, isPartner, SCOPE_LABEL } from '@/lib/knotwork/access';
import { createExpense, takeSnapshot, type ExpenseInput } from '@/lib/knotwork/budget-store';
import { logChange } from '@/lib/knotwork/changelog';
import { spendNeedsConsent } from '@/lib/knotwork/consent/machine';
import { decide, hasPending, propose } from '@/lib/knotwork/consent/store';
import { loadWedding, loadWho, need, requireWedding, todayOf } from '@/lib/knotwork/context';
import { dbOfDay, isRealDay, showDay } from '@/lib/knotwork/days';
import { parseCents, usd } from '@/lib/knotwork/money';
import { assertValidPlan, createWedding as createWeddingRows, loadTasks, lockWedding, previewDateMove, toPlan } from '@/lib/knotwork/schedule/store';
import { VENDOR_CATEGORIES } from '@/lib/knotwork/vendors/brief';
import { parseHHMM } from '@/lib/knotwork/vendors/scope';
import { acknowledgeFlag as ackFlag, addPayment, generateBrief, updateVendor as updateVendorRow } from '@/lib/knotwork/vendors/store';
import { parsePrivacy, revealDayOf, sealed, type Compartment, type ItemKind } from '@/lib/knotwork/secrecy/compartment';
import { lens } from '@/lib/knotwork/secrecy/lens';
import { canSee, revealForProposal, seen } from '@/lib/knotwork/secrecy/store';
import { unlinkFunder } from '@/lib/knotwork/funding/store';

// Every Knotwork write (PRD Phase 1). Each is an orgAction, so the template's harness drives it (INV-01..04, INV-22).
// Order inside every body: capability, then every ref (a row of another org is notFound, like a missing one), then the
// rules (Refused), then the write and its change-log line in one transaction.
//
// RULE 2: nothing here books a vendor, signs a contract, spends over the threshold, moves the date or changes the
// approval rules. Those actions PROPOSE; src/lib/knotwork/consent/execute.ts does them when the other partner approves.
//
// P1-1 (ADR-001): a task, expense, vendor or category hidden from the person asking is notFound, like a row of another
// workspace (every *In helper below). A new one may be made private to the partner creating it (`privacy`); proposing
// a designated action on a private item reveals it first (revealForProposal).

const home = (ctx: OrgCtx, page = '') => `/o/${ctx.slug}/wedding${page}`;

// ---- form fields. A form posts strings; tests and the harness may post numbers. Money is typed dollars → integer cents.
const text = (label: string, max = 120) => z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);
const note = (max = 2000) => z.string().trim().max(max).default('');
const wholeNumber = (label: string, min: number, max: number) =>
  z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
    const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) c.addIssue({ code: 'custom', message: `${label}: a whole number from ${min} to ${max}.` });
    return n;
  });
const optionalNumber = (label: string, max: number) =>
  z.union([z.number().int(), z.string().max(40)]).optional().transform((v, c) => {
    if (v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > max) c.addIssue({ code: 'custom', message: `${label}: a whole number from 0 to ${max}, or leave it empty.` });
    return n;
  });
const money = (label: string) =>
  z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
    const cents = typeof v === 'number' ? v : parseCents(v);
    if (cents === null || !Number.isInteger(cents) || cents < 0 || cents > 100_000_000_00) c.addIssue({ code: 'custom', message: `${label}: an amount like 1,250.00.` });
    return cents ?? 0;
  });
const optionalMoney = (label: string) =>
  z.union([z.number().int(), z.string().max(40)]).optional().transform((v, c) => {
    if (v === undefined || v === '') return null;
    const cents = typeof v === 'number' ? v : parseCents(v);
    if (cents === null || !Number.isInteger(cents) || cents < 0) c.addIssue({ code: 'custom', message: `${label}: an amount like 1,250.00, or leave it empty.` });
    return cents;
  });
const clock = (label: string) =>
  z.union([z.number().int(), z.string().max(40)]).optional().transform((v, c) => {
    if (v === undefined || v === '') return null;
    const m = typeof v === 'number' ? (Number.isInteger(v) && v >= 0 && v < 1440 ? v : null) : parseHHMM(v);
    if (m === null) c.addIssue({ code: 'custom', message: `${label}: use HH:MM.` });
    return m;
  });
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');
/** '' means today. Checked in the body (after the refs), so a foreign id is notFound before a bad date is refused. */
const dayOrToday = z.union([z.literal(''), z.string().trim().max(10)]).default('');
const optionalRef = (model: string) => z.union([ref(model), z.literal('')]).optional().transform((v) => v || null);
/** P1-1: '' shared; 'never'; or whole days after the wedding date (negative: before). Checked in the body, after the refs. */
const privacyField = z.union([z.number().int(), z.string().max(12)]).optional().transform((v) => v ?? '');

const realDay = (s: string, fallback: string) => {
  if (s === '') return fallback;
  if (!isRealDay(s)) throw new Refused('Pick a real date.');
  return s;
};
/** A row the asker may not see (another workspace's, or one private to the other partner) is notFound. */
async function visible(tx: Tx, ctx: OrgCtx, kind: ItemKind, id: string) {
  if (!(await canSee(tx, ctx, kind, id))) notFound();
}
async function taskIn(tx: Tx, ctx: OrgCtx, id: string) {
  const t = (await tx.task.findFirst({ where: { id, ...inOrg(ctx) }, include: { payment: { select: { id: true } } } })) ?? notFound();
  await visible(tx, ctx, 'task', id);
  return t;
}
async function memberIn(tx: Tx, ctx: OrgCtx, userId: string | null) {
  if (userId && !(await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } }, select: { role: true } }))) notFound();
}
async function vendorIn(tx: Tx, ctx: OrgCtx, id: string) {
  const v = (await tx.vendor.findFirst({ where: { id, ...inOrg(ctx) } })) ?? notFound();
  await visible(tx, ctx, 'vendor', id);
  return v;
}
async function categoryIn(tx: Tx, ctx: OrgCtx, id: string) {
  const c = (await tx.budgetCategory.findFirst({ where: { id, ...inOrg(ctx) } })) ?? notFound();
  await visible(tx, ctx, 'category', id);
  return c;
}

/**
 * P1-1: the compartment a new item is created in, from its form's `privacy` field, or null for shared. Only a partner
 * keeps a secret; the reveal point must still be ahead; a private task is assigned to its owner or to nobody.
 */
async function newSecret(tx: Tx, ctx: OrgCtx, raw: string | number, assigneeId: string | null = null): Promise<Compartment | null> {
  const p = parsePrivacy(raw);
  if (!p) throw new Refused('Pick when it should be revealed: the wedding day, a number of days before or after, or never.');
  if (!p.private) return null;
  if (!isPartner(ctx.role)) throw new Refused('Only the two partners can keep something private.');
  const s = await seen(tx, ctx);
  const day = revealDayOf(s.weddingDay, p.revealDays);
  if (day !== null && s.today >= day) throw new Refused('That reveal point has already passed. Pick a later one, or keep it private until you reveal it.');
  if (assigneeId && assigneeId !== ctx.userId) throw new Refused('Only a task assigned to you, or to nobody, can be private to you.');
  return { privateToId: ctx.userId, revealDays: p.revealDays };
}

// ---------------------------------------------------------------------------------------------------------------------
// Wedding and schedule (P0-1)

export const createWedding = orgAction(
  null,
  z.object({ title: text('A name for the wedding'), date: z.string().trim().refine(isRealDay, 'Pick the wedding date.'), timeZone: z.string().trim().max(64).default('') }),
  async (ctx, i) => {
    const timeZone = i.timeZone || 'America/Chicago';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new Refused('That time zone is not one we know. Use a name like America/Chicago.');
    }
    await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'wedding.create');
      if (await loadWedding(tx, ctx)) throw new Refused('This workspace already has a wedding.');
      await createWeddingRows(tx, ctx, { title: i.title, date: i.date, timeZone });
    });
    redirect(home(ctx, '/schedule'));
  },
);

const taskFields = { title: text('Title'), leadDays: wholeNumber('Days it takes', 0, 3650), bufferDays: wholeNumber('Days before the wedding', 0, 3650), assigneeId: optionalRef('member'), dependsOn: z.array(ref('task')).max(50).default([]) };
/** The plan check, with any task hidden from the asker named "Private task" in the refusal. */
async function assertValidPlanFor(tx: Tx, ctx: OrgCtx, edit: (plan: ReturnType<typeof toPlan>) => ReturnType<typeof toPlan> = (p) => p) {
  const rows = await loadTasks(tx, ctx);
  assertValidPlan(lens(await seen(tx, ctx)).plan(edit(toPlan(rows)), rows));
}

async function setDependencies(tx: Tx, ctx: OrgCtx, taskId: string, dependsOn: string[]) {
  await tx.taskDependency.deleteMany({ where: { taskId, ...inOrg(ctx) } });
  if (dependsOn.length) await tx.taskDependency.createMany({ data: [...new Set(dependsOn)].map((dependsOnId) => ({ orgId: ctx.orgId, taskId, dependsOnId })) });
}

export const addTask = orgAction(null, z.object({ ...taskFields, privacy: privacyField }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'schedule.edit');
    for (const d of i.dependsOn) await taskIn(tx, ctx, d);
    await memberIn(tx, ctx, i.assigneeId);
    await requireWedding(tx, ctx);
    const secret = await newSecret(tx, ctx, i.privacy, i.assigneeId);
    await lockWedding(tx, ctx.orgId);
    const t = await tx.task.create({ data: { orgId: ctx.orgId, title: i.title, kind: 'manual', leadDays: i.leadDays, bufferDays: i.bufferDays, assigneeId: i.assigneeId, ...secret } });
    await setDependencies(tx, ctx, t.id, i.dependsOn);
    await assertValidPlanFor(tx, ctx);
    await logChange(tx, ctx, 'task', 'created', t.id, t.title, null, { title: i.title, leadDays: i.leadDays, bufferDays: i.bufferDays, assigneeId: i.assigneeId, dependsOn: [...i.dependsOn].sort() });
  });
  redirect(home(ctx, '/schedule'));
});

export const updateTask = orgAction(null, z.object({ id: ref('task'), ...taskFields }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'schedule.edit');
    const t = await taskIn(tx, ctx, i.id);
    for (const d of i.dependsOn) await taskIn(tx, ctx, d);
    await memberIn(tx, ctx, i.assigneeId);
    await lockWedding(tx, ctx.orgId);
    const was = (await tx.taskDependency.findMany({ where: { taskId: t.id, ...inOrg(ctx) }, select: { dependsOnId: true } })).map((d) => d.dependsOnId).sort();
    // A dependency on a task hidden from this editor is not on their form, so it is kept, not dropped (P1-1).
    const keep: string[] = [];
    for (const d of was) if (!(await canSee(tx, ctx, 'task', d))) keep.push(d);
    if (i.assigneeId && i.assigneeId !== t.privateToId && sealed(t, await seen(tx, ctx))) throw new Refused('Only a task assigned to you, or to nobody, can be private to you.');
    // A payment task's timing belongs to its payment, and the RSVP deadline is derived: only the assignee and the dependencies are open.
    if (t.kind === 'payment' || t.kind === 'rsvp') {
      if (i.leadDays !== t.leadDays || i.bufferDays !== t.bufferDays || i.title !== t.title) throw new Refused(t.kind === 'payment' ? 'This task follows its vendor payment. Change the payment instead.' : 'The RSVP deadline is worked out from the vendors\' count deadlines.');
    }
    // The plan as it would be, checked before anything is written: a circle or a self-dependency is refused by name.
    const deps = [...new Set([...i.dependsOn, ...keep])].sort();
    await assertValidPlanFor(tx, ctx, (plan) => plan.map((p) => (p.id === t.id ? { ...p, title: i.title, leadDays: i.leadDays, bufferDays: i.bufferDays, dependsOn: deps } : p)));
    await tx.task.update({ where: { id: t.id }, data: { title: i.title, leadDays: i.leadDays, bufferDays: i.bufferDays, assigneeId: i.assigneeId } });
    await setDependencies(tx, ctx, t.id, deps);
    await logChange(tx, ctx, 'task', 'updated', t.id, i.title, { title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, assigneeId: t.assigneeId, dependsOn: was }, { title: i.title, leadDays: i.leadDays, bufferDays: i.bufferDays, assigneeId: i.assigneeId, dependsOn: deps });
  });
  redirect(home(ctx, '/schedule'));
});

export const setTaskStatus = orgAction(null, z.object({ id: ref('task'), status: z.enum(['todo', 'in_progress', 'done']) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    const who = await loadWho(tx, ctx);
    const t = await taskIn(tx, ctx, i.id);
    if (t.assigneeId !== ctx.userId) need(who, 'schedule.edit'); // anyone may move their own task along
    if (t.kind === 'payment') throw new Refused('A payment task is finished by recording the payment on the vendor\'s page.');
    const wedding = await requireWedding(tx, ctx);
    const completedOn = i.status === 'done' ? (t.completedOn ?? dbOfDay(todayOf(wedding))) : null;
    await tx.task.update({ where: { id: t.id }, data: { status: i.status, completedOn } });
    await logChange(tx, ctx, 'task', 'updated', t.id, t.title, { status: t.status }, { status: i.status });
  });
  redirect(home(ctx, '/schedule'));
});

export const removeTask = orgAction(null, z.object({ id: ref('task') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'schedule.edit');
    const t = await taskIn(tx, ctx, i.id);
    if (t.kind === 'payment' || t.kind === 'rsvp') throw new Refused('That task is kept by the app and cannot be removed here.');
    await lockWedding(tx, ctx.orgId);
    // Logged first: whether the entry may carry the title is read from the row (P1-1), which is about to go.
    await logChange(tx, ctx, 'task', 'deleted', t.id, t.title, { title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, status: t.status }, null);
    await tx.task.delete({ where: { id: t.id } }); // its dependency edges go with it
  });
  redirect(home(ctx, '/schedule'));
});

/** Designated (change date): this only proposes. The proposer must have seen the preview they are proposing. */
export const proposeDateMove = orgAction(null, z.object({ to: z.string().trim().refine(isRealDay, 'Pick the new date.'), fingerprint: z.string().trim().min(1, 'Look at the preview first.').max(32) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'consent.propose');
    const wedding = await requireWedding(tx, ctx);
    const { preview, from } = await previewDateMove(tx, ctx, wedding, i.to);
    if (from === i.to) throw new Refused('The wedding is already on that date.');
    if (preview.fingerprint !== i.fingerprint) throw new Refused('The plan changed since this preview was made. Look at the new preview, then propose again.');
    if (await hasPending(tx, ctx, 'change_date')) throw new Refused('A date change is already waiting for your partner.');
    await propose(tx, ctx, wedding, 'change_date', { from, to: i.to }, `Move the wedding from ${showDay(from)} to ${showDay(i.to)}`, { fingerprint: i.fingerprint });
  });
  redirect(home(ctx, '/approvals'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Budget (P0-7)

export const addCategory = orgAction(null, z.object({ name: text('Name', 60), estimate: money('Estimate'), privacy: privacyField }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    // The same refusal whether or not the other one is private: the name is taken either way (D-98).
    if (await tx.budgetCategory.findFirst({ where: { ...inOrg(ctx), name: i.name }, select: { id: true } })) throw new Refused('There is already a category with that name.');
    const secret = await newSecret(tx, ctx, i.privacy);
    const c = await tx.budgetCategory.create({ data: { orgId: ctx.orgId, name: i.name, estimateCents: i.estimate, ...secret } });
    await logChange(tx, ctx, 'category', 'created', c.id, c.name, null, { name: c.name, estimateCents: c.estimateCents });
  });
  redirect(home(ctx, '/budget'));
});

export const updateCategory = orgAction(null, z.object({ id: ref('budgetCategory'), name: text('Name', 60), estimate: money('Estimate') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    const c = await categoryIn(tx, ctx, i.id);
    if (await tx.budgetCategory.findFirst({ where: { ...inOrg(ctx), name: i.name, NOT: { id: c.id } }, select: { id: true } })) throw new Refused('There is already a category with that name.');
    await tx.budgetCategory.update({ where: { id: c.id }, data: { name: i.name, estimateCents: i.estimate } });
    await logChange(tx, ctx, 'category', 'updated', c.id, i.name, { name: c.name, estimateCents: c.estimateCents }, { name: i.name, estimateCents: i.estimate });
  });
  redirect(home(ctx, '/budget'));
});

/** Records the spend, or, strictly over the threshold, proposes it (designated: spend > $X). Returns where it went. */
async function spendOrPropose(tx: Tx, ctx: OrgCtx, input: ExpenseInput, label: string): Promise<'recorded' | 'proposed'> {
  const wedding = await requireWedding(tx, ctx);
  if (input.amountCents <= 0) throw new Refused('The amount must be more than zero.');
  if (!spendNeedsConsent(input.amountCents, wedding.spendThresholdCents)) {
    await createExpense(tx, ctx, wedding, input, null);
    return 'recorded';
  }
  if (!isPartner(ctx.role)) throw new Refused(`That is over ${usd(wedding.spendThresholdCents)}, so one of the partners has to propose it.`);
  // Designated (rule 2): it needs the other partner's key, so it cannot be private, and proposing it reveals the
  // category and the vendor it names (ADR-001).
  if (input.secret) throw new Refused(`A spend over ${usd(wedding.spendThresholdCents)} needs both of you, so it cannot be private.`);
  await revealForProposal(tx, ctx, [{ kind: 'category', id: input.categoryId }, input.vendorId ? { kind: 'vendor', id: input.vendorId } : null]);
  const payload: Omit<ExpenseInput, 'secret'> & { secret?: unknown } = { ...input };
  delete payload.secret;
  const r = await propose(tx, ctx, wedding, 'spend', payload as unknown as Prisma.InputJsonObject, `Spend ${usd(input.amountCents)}: ${label}`);
  return r.executed ? 'recorded' : 'proposed'; // solo mode (D-33) executes at once
}

export const addExpense = orgAction(
  null,
  z.object({ categoryId: ref('budgetCategory'), vendorId: optionalRef('vendor'), description: text('What it was for', 200), amount: money('Amount'), paidOn: dayOrToday, privacy: privacyField }),
  async (ctx, i) => {
    const went = await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'budget.edit');
      const c = await categoryIn(tx, ctx, i.categoryId);
      if (i.vendorId) await vendorIn(tx, ctx, i.vendorId);
      const paidOn = realDay(i.paidOn, todayOf(await requireWedding(tx, ctx)));
      const secret = await newSecret(tx, ctx, i.privacy);
      return spendOrPropose(tx, ctx, { categoryId: c.id, vendorId: i.vendorId, description: i.description, amountCents: i.amount, paidOn, paymentId: null, secret }, `${i.description} (${c.name})`);
    });
    redirect(home(ctx, went === 'proposed' ? '/approvals' : '/budget'));
  },
);

export const takeBudgetSnapshot = orgAction(null, z.object({ note: note(200) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'budget.edit');
    await takeSnapshot(tx, ctx, i.note);
  });
  redirect(home(ctx, '/budget'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Vendor book (P0-7) and re-confirmation flags (P0-2)

export const addVendor = orgAction(
  null,
  z.object({ name: text('Name'), category: z.enum(VENDOR_CATEGORIES), contactName: note(120), email: note(200), phone: note(40), privacy: privacyField }),
  async (ctx, { privacy, ...i }) => {
    const id = await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'vendors.edit');
      const secret = await newSecret(tx, ctx, privacy);
      const v = await tx.vendor.create({ data: { orgId: ctx.orgId, ...i, ...secret } });
      await logChange(tx, ctx, 'vendor', 'created', v.id, v.name, null, { name: v.name, category: v.category, status: v.status });
      return v.id;
    });
    redirect(home(ctx, `/vendors/${id}`));
  },
);

export const updateVendor = orgAction(
  null,
  z.object({
    id: ref('vendor'), name: text('Name'), category: z.enum(VENDOR_CATEGORIES), contactName: note(120), email: note(200), phone: note(40), notes: note(),
    deliverables: note(4000), arrive: clock('Arrival'), depart: clock('Departure'), countEstimate: optionalNumber('Count estimate', 100_000),
    countDueDaysBefore: optionalNumber('Count deadline', 3650), onSite: checkbox, contractTotal: optionalMoney('Contract total'),
  }),
  async (ctx, { id, arrive, depart, contractTotal, ...rest }) => {
    await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'vendors.edit');
      await vendorIn(tx, ctx, id);
      await updateVendorRow(tx, ctx, id, { ...rest, arriveMin: arrive, departMin: depart, contractTotalCents: contractTotal });
    });
    redirect(home(ctx, `/vendors/${id}`));
  },
);

/** Designated (book vendor): proposes only. */
export const proposeBooking = orgAction(null, z.object({ id: ref('vendor') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'consent.propose');
    const v = await vendorIn(tx, ctx, i.id);
    if (v.status !== 'considering') throw new Refused(v.status === 'booked' ? 'That vendor is already booked.' : 'That vendor was dropped.');
    if (await hasPending(tx, ctx, 'book_vendor', v.id)) throw new Refused('Booking this vendor is already waiting for your partner.');
    await revealForProposal(tx, ctx, [{ kind: 'vendor', id: v.id }]); // designated: the approver sees what they approve
    await propose(tx, ctx, await requireWedding(tx, ctx), 'book_vendor', { vendorId: v.id }, `Book ${v.name} (${v.category})`);
  });
  redirect(home(ctx, '/approvals'));
});

/** Designated (sign contract): proposes only. The total proposed is the total that gets signed. */
export const proposeContract = orgAction(null, z.object({ id: ref('vendor'), total: money('Contract total') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'consent.propose');
    const v = await vendorIn(tx, ctx, i.id);
    if (v.contractSignedOn) throw new Refused('That contract is already signed.');
    if (await hasPending(tx, ctx, 'sign_contract', v.id)) throw new Refused('Signing this contract is already waiting for your partner.');
    await revealForProposal(tx, ctx, [{ kind: 'vendor', id: v.id }]);
    await propose(tx, ctx, await requireWedding(tx, ctx), 'sign_contract', { vendorId: v.id, totalCents: i.total }, `Sign the contract with ${v.name} for ${usd(i.total)}`);
  });
  redirect(home(ctx, '/approvals'));
});

export const addVendorPayment = orgAction(
  null,
  z.object({ vendorId: ref('vendor'), label: text('Label', 60), amount: money('Amount'), dueDaysBefore: wholeNumber('Days before the wedding', 0, 3650) }),
  async (ctx, i) => {
    await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'vendors.edit');
      await vendorIn(tx, ctx, i.vendorId);
      await requireWedding(tx, ctx);
      if (i.amount <= 0) throw new Refused('The amount must be more than zero.');
      await lockWedding(tx, ctx.orgId);
      await addPayment(tx, ctx, i.vendorId, { label: i.label, amountCents: i.amount, dueDaysBefore: i.dueDaysBefore });
    });
    redirect(home(ctx, `/vendors/${i.vendorId}`));
  },
);

/** Pays a scheduled payment into a budget category: recorded, or proposed when it is over the threshold (D-24). */
export const payVendorPayment = orgAction(null, z.object({ id: ref('vendorPayment'), categoryId: ref('budgetCategory'), paidOn: dayOrToday }), async (ctx, i) => {
  const out = await withOrg(ctx, async (tx) => {
    const who = await loadWho(tx, ctx);
    need(who, 'vendors.edit');
    need(who, 'budget.edit');
    const p = (await tx.vendorPayment.findFirst({ where: { id: i.id, ...inOrg(ctx) }, include: { vendor: { select: { name: true } } } })) ?? notFound();
    await visible(tx, ctx, 'vendor', p.vendorId);
    const c = await categoryIn(tx, ctx, i.categoryId);
    if (p.paidOn) throw new Refused('That payment has already been paid.');
    const paidOn = realDay(i.paidOn, todayOf(await requireWedding(tx, ctx)));
    const went = await spendOrPropose(tx, ctx, { categoryId: c.id, vendorId: p.vendorId, description: `${p.vendor.name}: ${p.label}`, amountCents: p.amountCents, paidOn, paymentId: p.id }, `${p.vendor.name}: ${p.label}`);
    return { went, vendorId: p.vendorId };
  });
  redirect(home(ctx, out.went === 'proposed' ? '/approvals' : `/vendors/${out.vendorId}`));
});

export const acknowledgeFlag = orgAction(null, z.object({ id: ref('vendorFlag'), note: note(500) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'vendors.edit');
    const f = (await tx.vendorFlag.findFirst({ where: { id: i.id, ...inOrg(ctx) }, select: { vendorId: true } })) ?? notFound();
    await visible(tx, ctx, 'vendor', f.vendorId);
    if (!(await ackFlag(tx, ctx, i.id, i.note))) throw new Refused('That flag was already acknowledged.');
  });
  redirect(home(ctx, '/flags'));
});

export const regenerateBrief = orgAction(null, z.object({ id: ref('vendor') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'vendors.edit');
    await vendorIn(tx, ctx, i.id);
    await requireWedding(tx, ctx);
    await generateBrief(tx, ctx, i.id);
  });
  redirect(home(ctx, `/vendors/${i.id}`));
});

// ---------------------------------------------------------------------------------------------------------------------
// Two-key consent (P0-2)

const requestIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.consentRequest.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();

/** The second key. The action it allows happens in this same transaction, or the approval does not happen either. */
export const approveRequest = orgAction(null, z.object({ id: ref('consentRequest'), fingerprint: z.string().trim().max(32).default('') }), async (ctx, i) => {
  const d = await withOrg(ctx, async (tx) => {
    await requestIn(tx, ctx, i.id);
    return decide(tx, ctx, i.id, 'approve', { fingerprint: i.fingerprint || undefined });
  });
  if (!d.ok) throw new Refused(d.message);
  redirect(home(ctx, '/approvals'));
});

export const declineRequest = orgAction(null, z.object({ id: ref('consentRequest'), reason: note(500) }), async (ctx, i) => {
  const d = await withOrg(ctx, async (tx) => {
    await requestIn(tx, ctx, i.id);
    return decide(tx, ctx, i.id, 'decline', { reason: i.reason });
  });
  if (!d.ok) throw new Refused(d.message);
  redirect(home(ctx, '/approvals'));
});

export const withdrawRequest = orgAction(null, z.object({ id: ref('consentRequest') }), async (ctx, i) => {
  const d = await withOrg(ctx, async (tx) => {
    await requestIn(tx, ctx, i.id);
    return decide(tx, ctx, i.id, 'withdraw');
  });
  if (!d.ok) throw new Refused(d.message);
  redirect(home(ctx, '/approvals'));
});

/** Designated (D-12): the rules themselves take two keys, or one partner could raise the threshold and spend alone. */
export const proposeSettings = orgAction(
  null,
  z.object({ spendThreshold: money('Spend threshold'), consentExpiryDays: wholeNumber('Days until a request expires', 1, 90), chaseBufferDays: wholeNumber('RSVP chase buffer', 0, 365) }),
  async (ctx, i) => {
    await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'consent.propose');
      const w = await requireWedding(tx, ctx);
      if (w.spendThresholdCents === i.spendThreshold && w.consentExpiryDays === i.consentExpiryDays && w.chaseBufferDays === i.chaseBufferDays) throw new Refused('Those are already the rules.');
      if (await hasPending(tx, ctx, 'change_settings')) throw new Refused('A change to the rules is already waiting for your partner.');
      await propose(tx, ctx, w, 'change_settings', { spendThresholdCents: i.spendThreshold, consentExpiryDays: i.consentExpiryDays, chaseBufferDays: i.chaseBufferDays },
        `Change the approval rules: spend over ${usd(i.spendThreshold)} needs both, requests expire after ${i.consentExpiryDays} days, RSVP chase buffer ${i.chaseBufferDays} days`);
    });
    redirect(home(ctx, '/approvals'));
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Helpers (P0-2: scoped grants)

export const grantHelper = orgAction(null, z.object({ userId: ref('member'), scope: z.enum(GRANT_SCOPES) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'helpers.manage');
    const m = (await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: i.userId } }, select: { role: true, user: { select: { email: true } } } })) ?? notFound();
    if (isPartner(m.role)) throw new Refused('A partner already has full access.');
    if (i.scope === 'funder') throw new Refused('Link them to a funder on the Funding page instead.');
    if (await tx.helperGrant.findFirst({ where: { ...inOrg(ctx), userId: i.userId, scope: i.scope }, select: { id: true } })) throw new Refused('They already have that.');
    const g = await tx.helperGrant.create({ data: { orgId: ctx.orgId, userId: i.userId, scope: i.scope, grantedById: ctx.userId } });
    await logChange(tx, ctx, 'grant', 'granted', g.id, `${m.user.email}: ${SCOPE_LABEL[i.scope]}`, null, { userId: i.userId, scope: i.scope });
  });
  redirect(home(ctx, '/helpers'));
});

export const revokeHelper = orgAction(null, z.object({ id: ref('helperGrant') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'helpers.manage');
    const g = (await tx.helperGrant.findFirst({ where: { id: i.id, ...inOrg(ctx) } })) ?? notFound();
    // A funder grant goes with its link (P1-2): unlinking removes the grant and logs both.
    const linked = g.scope === 'funder' ? await tx.funder.findFirst({ where: { ...inOrg(ctx), userId: g.userId }, select: { id: true } }) : null;
    if (linked) return unlinkFunder(tx, ctx, linked.id);
    await tx.helperGrant.delete({ where: { id: g.id } });
    await logChange(tx, ctx, 'grant', 'revoked', g.id, SCOPE_LABEL[g.scope], { userId: g.userId, scope: g.scope }, null);
  });
  redirect(home(ctx, '/helpers'));
});

