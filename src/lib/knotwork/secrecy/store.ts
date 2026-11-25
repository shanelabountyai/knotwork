// P1-1 (ADR-001): marking an item private, revealing it, and the reveal that a proposal forces. A store; everything
// runs inside the caller's withOrg transaction, and every write is logged in it.
//
// Who: only a partner keeps a secret, and only from the other partner and the helpers (helpers see what the other
// partner sees; in solo mode, D-33, the helpers are the only others, D-97). What: a task, an expense, a vendor or a
// budget category. Never something designated (rule 2): a vendor that is booked, signed or named in any request, a
// category named in a spend request, a spend that went through consent. Proposing a designated action on a private
// item reveals it first (revealForProposal): the approver has to see what they approve, and the request's summary
// stays on the approvals page for good.
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { isPartner } from '../access';
import { setExpenseCompartment } from '../budget-store';
import { logChange } from '../changelog';
import { revealDayOf, sealed, type Compartment, type ItemKind, type Privacy, type Seen } from './compartment';
import { lens } from './lens';
import { compartmentsOf, seenOf } from './seal';

type Ctx = { orgId: string; userId: string; role: string };
type Item = { kind: ItemKind; id: string };
const ENTITY = { task: 'task', expense: 'expense', vendor: 'vendor', category: 'category' } as const;

/** The viewer's Seen, for the action's ref checks. Throws when there is no wedding (every caller needs one). */
export async function seen(tx: Tx, ctx: { orgId: string; userId: string }): Promise<Seen> {
  const s = await seenOf(tx, ctx.orgId, ctx.userId);
  if (!s) throw new Refused('Create the wedding first.');
  return s;
}

/**
 * May this viewer see the item at all? A row hidden from them is answered like a row of another workspace: the action
 * calls notFound(). Missing rows are also false.
 */
export async function canSee(tx: Tx, ctx: { orgId: string; userId: string }, kind: ItemKind, id: string): Promise<boolean> {
  const cs = (await compartmentsOf(tx, ctx.orgId, ENTITY[kind], [id])).get(id);
  if (!cs) return false;
  if (!cs.some((c) => c?.privateToId)) return true;
  const s = await seenOf(tx, ctx.orgId, ctx.userId);
  return !s || !lens(s).hides(cs);
}

async function load(tx: Tx, ctx: { orgId: string }, kind: ItemKind, id: string): Promise<Compartment & { label: string; extra: Record<string, unknown> }> {
  const where = { id, ...inOrg(ctx) };
  switch (kind) {
    case 'task': {
      const t = await tx.task.findFirstOrThrow({ where });
      return { ...t, label: t.title, extra: { kind: t.kind, assigneeId: t.assigneeId } };
    }
    case 'expense': {
      const e = await tx.expense.findFirstOrThrow({ where });
      return { ...e, label: e.description, extra: { requestId: e.requestId } };
    }
    case 'vendor': {
      const v = await tx.vendor.findFirstOrThrow({ where });
      return { ...v, label: v.name, extra: { status: v.status, signed: !!v.contractSignedOn } };
    }
    case 'category': {
      const c = await tx.budgetCategory.findFirstOrThrow({ where });
      return { ...c, label: c.name, extra: {} };
    }
  }
}

async function write(tx: Tx, ctx: { orgId: string }, kind: ItemKind, id: string, data: Compartment) {
  const where = { id, orgId: ctx.orgId };
  if (kind === 'task') await tx.task.update({ where, data });
  else if (kind === 'expense') await setExpenseCompartment(tx, ctx, id, data);
  // D-128: a private vendor has no read-only link, so making one private ends its link at once.
  else if (kind === 'vendor') await tx.vendor.update({ where, data: data.privateToId ? { ...data, linkTokenHash: null, linkTokenSealed: null } : data });
  else await tx.budgetCategory.update({ where, data });
}

/** Has any request (pending or decided) named this vendor or category? Then both partners have seen its name. */
async function namedInRequest(tx: Tx, ctx: { orgId: string }, kind: 'vendor' | 'category', id: string): Promise<boolean> {
  const rows = await tx.consentRequest.findMany({ where: { ...inOrg(ctx), kind: { in: kind === 'vendor' ? ['book_vendor', 'sign_contract', 'spend'] : ['spend'] } }, select: { payload: true } });
  return rows.some((r) => (r.payload as Record<string, unknown>)[kind === 'vendor' ? 'vendorId' : 'categoryId'] === id);
}

/** Why this item cannot be private, or null. */
async function cannotBePrivate(tx: Tx, ctx: Ctx, kind: ItemKind, id: string, extra: Record<string, unknown>): Promise<string | null> {
  if (kind === 'task') {
    if (extra.kind === 'payment') return 'A payment task follows its vendor: make the vendor private instead.';
    if (extra.kind === 'rsvp') return 'The RSVP deadline is worked out by the app from the booked vendors, so it cannot be private.';
    if (extra.assigneeId && extra.assigneeId !== ctx.userId) return 'Only a task assigned to you, or to nobody, can be private to you.';
  }
  if (kind === 'expense' && extra.requestId) return 'That spend needed both of you, so it cannot be private.';
  if (kind === 'vendor' && (extra.status === 'booked' || extra.signed || (await namedInRequest(tx, ctx, 'vendor', id)))) return 'This vendor has been through an approval, so both of you already know about it. It cannot be made private.';
  if (kind === 'category' && (await namedInRequest(tx, ctx, 'category', id))) return 'A spend in this category has been through an approval, so both of you already know about it. It cannot be made private.';
  return null;
}

/**
 * Sets an item's privacy as its owner (or as the partner who is making a shared item private). The caller has proved
 * the viewer can see the item. Returns what happened: 'hidden' (made private, or its reveal point changed),
 * 'revealed', or 'unchanged'.
 */
export async function setPrivacy(tx: Tx, ctx: Ctx, kind: ItemKind, id: string, p: Privacy): Promise<'hidden' | 'revealed' | 'unchanged'> {
  if (!isPartner(ctx.role)) throw new Refused('Only the two partners can keep something private.');
  const s = await seen(tx, ctx);
  const row = await load(tx, ctx, kind, id);
  const mine = sealed(row, s) && row.privateToId === ctx.userId;
  if (sealed(row, s) && !mine) throw new Error('setPrivacy: an item hidden from this partner'); // callers 404 first
  if (!p.private) {
    if (!mine) throw new Refused('That is already shared.');
    return (await reveal(tx, ctx, kind, id, row.label, row, 'by hand')) ? 'revealed' : 'unchanged';
  }
  const day = revealDayOf(s.weddingDay, p.revealDays);
  if (day !== null && s.today >= day) throw new Refused('That reveal point has already passed. Pick a later one, or keep it private until you reveal it.');
  const why = await cannotBePrivate(tx, ctx, kind, id, row.extra);
  if (why) throw new Refused(why);
  if (mine && row.revealDays === p.revealDays) return 'unchanged';
  await write(tx, ctx, kind, id, { privateToId: ctx.userId, revealDays: p.revealDays });
  // The item is sealed now, so this entry is written without its label (changelog.ts).
  await logChange(tx, ctx, ENTITY[kind], mine ? 'updated' : 'hidden', id, row.label, { private: mine, revealDays: mine ? row.revealDays : null }, { private: true, revealDays: p.revealDays });
  return 'hidden';
}

async function reveal(tx: Tx, ctx: Ctx, kind: ItemKind, id: string, label: string, was: Compartment, why: 'by hand' | 'proposed'): Promise<boolean> {
  await write(tx, ctx, kind, id, { privateToId: null, revealDays: null });
  return logChange(tx, ctx, ENTITY[kind], 'revealed', id, label, { private: true, revealDays: was.revealDays }, { private: false }, { why });
}

/**
 * Before a designated action is proposed: every named item that is sealed is revealed, by its owner (the proposer).
 * The caller has proved the proposer can see each item, so a sealed one here is theirs. Returns how many.
 */
export async function revealForProposal(tx: Tx, ctx: Ctx, items: readonly (Item | null)[]): Promise<number> {
  const s = await seen(tx, ctx);
  let n = 0;
  for (const it of items) {
    if (!it) continue;
    const row = await load(tx, ctx, it.kind, it.id);
    if (!sealed(row, s)) continue;
    if (row.privateToId !== ctx.userId) throw new Error('revealForProposal: an item hidden from the proposer');
    await reveal(tx, ctx, it.kind, it.id, row.label, row, 'proposed');
    n++;
  }
  return n;
}
