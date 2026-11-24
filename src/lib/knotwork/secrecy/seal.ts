// P1-1 (ADR-001): which compartments a row sits in, read from the database, and who is looking. A store.
//
// changelog.ts calls `sealedNow` before it writes an entry, so an entry about a sealed item never holds its label or
// its before/after (the audit log is append-only and goes whole into the data export). The activity feed and the
// export call `compartmentsOf` to mask what was written before an item became private.
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { dayOfDb, todayIn } from '../days';
import { NOBODY, sealed, type Compartment, type Seen } from './compartment';
import { lens, type Lens } from './lens';

const SEL = { privateToId: true, revealDays: true } as const;
type Cs = (Compartment | null)[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is looking, the partners, and today in the wedding's time zone. Null before there is a wedding. */
export async function seenOf(tx: Tx, orgId: string, viewerId: string): Promise<Seen | null> {
  const w = await tx.wedding.findUnique({ where: { orgId }, select: { date: true, timeZone: true } });
  if (!w) return null;
  const partners = (await tx.membership.findMany({ where: { orgId, role: 'owner' }, select: { userId: true } })).map((m) => m.userId);
  return { viewerId, partners, weddingDay: dayOfDb(w.date), today: todayIn(w.timeZone, now()) };
}

/**
 * The compartments each row sits in, by the change log's entity name: its own, and the ones it inherits (a task from
 * its vendor; an expense from its category and its vendor; a payment, flag, brief or attachment from its vendor; a
 * pledge, receipt or allocation from its category, and an allocation also from its expense; an unshared name change
 * is its own partner's). Other entities: none.
 */
export async function compartmentsOf(tx: Tx, orgId: string, entity: string, ids: readonly string[]): Promise<Map<string, Cs>> {
  const where = { orgId, id: { in: [...new Set(ids)].filter((x) => UUID.test(x)) } };
  const out = new Map<string, Cs>();
  if (!where.id.in.length) return out;
  const put = (id: string, cs: Cs) => out.set(id, cs);
  switch (entity) {
    case 'task':
      for (const r of await tx.task.findMany({ where, select: { id: true, ...SEL, vendor: { select: SEL } } })) put(r.id, [r, r.vendor]);
      break;
    case 'expense':
      for (const r of await tx.expense.findMany({ where, select: { id: true, ...SEL, category: { select: SEL }, vendor: { select: SEL } } })) put(r.id, [r, r.category, r.vendor]);
      break;
    case 'category':
      for (const r of await tx.budgetCategory.findMany({ where, select: { id: true, ...SEL } })) put(r.id, [r]);
      break;
    case 'vendor':
      for (const r of await tx.vendor.findMany({ where, select: { id: true, ...SEL } })) put(r.id, [r]);
      break;
    case 'payment':
      for (const r of await tx.vendorPayment.findMany({ where, select: { id: true, vendor: { select: SEL } } })) put(r.id, [r.vendor]);
      break;
    case 'flag':
      for (const r of await tx.vendorFlag.findMany({ where, select: { id: true, vendor: { select: SEL } } })) put(r.id, [r.vendor]);
      break;
    case 'brief':
      for (const r of await tx.vendorBrief.findMany({ where, select: { id: true, vendor: { select: SEL } } })) put(r.id, [r.vendor]);
      break;
    case 'attachment':
      for (const r of await tx.vendorAttachment.findMany({ where, select: { id: true, vendor: { select: SEL } } })) put(r.id, [r.vendor]);
      break;
    case 'pledge':
      for (const r of await tx.funderPledge.findMany({ where, select: { id: true, category: { select: SEL } } })) put(r.id, [r.category]);
      break;
    case 'receipt':
      for (const r of await tx.funderReceipt.findMany({ where, select: { id: true, pledge: { select: { category: { select: SEL } } } } })) put(r.id, [r.pledge.category]);
      break;
    case 'allocation':
      for (const r of await tx.funderAllocation.findMany({ where, select: { id: true, pledge: { select: { category: { select: SEL } } }, expense: { select: { ...SEL, category: { select: SEL }, vendor: { select: SEL } } } } })) {
        put(r.id, [r.pledge.category, r.expense, r.expense.category, r.expense.vendor]);
      }
      break;
    case 'namechange':
      // P1-4 (D-114): an unshared name change is its partner's own compartment, with no reveal day (sharing is the reveal).
      for (const r of await tx.nameChange.findMany({ where, select: { id: true, userId: true, shared: true } })) put(r.id, [r.shared ? null : { privateToId: r.userId, revealDays: null }]);
      break;
  }
  return out;
}

/** Is this row sealed right now, to anyone? Reads the wedding and the partners only when some compartment is set. */
export async function sealedNow(tx: Tx, orgId: string, entity: string, id: string): Promise<boolean> {
  const cs = (await compartmentsOf(tx, orgId, entity, [id])).get(id) ?? [];
  if (!cs.some((c) => c?.privateToId)) return false;
  const seen = await seenOf(tx, orgId, NOBODY);
  return !!seen && cs.some((c) => sealed(c, seen));
}

/**
 * The lens for nobody: every sealed item hidden, whoever owns it. For what is stored and shared (a baseline snapshot,
 * a budget snapshot, a vendor brief) and for the data export, which either partner may download. Null with no wedding.
 */
export async function nobodyLens(tx: Tx, orgId: string): Promise<Lens | null> {
  const s = await seenOf(tx, orgId, NOBODY);
  return s ? lens(s) : null;
}
