// P1-1 (ADR-001): the data export's view of the item tables. A store.
//
// Either partner may download the export (the template's export is owner-only, and both partners are owners), so it is
// built for NOBODY: every item that is sealed right now is blanked whoever owns it (its label, vendor name, notes,
// contact details), and so is what belongs to it (a payment's label, a brief's body, an attachment's label, a task
// title in a baseline, a category line in a budget snapshot). Ids, amounts and dates of fact stay, so every total in
// the export still adds up. The change log (AuditEvent) is exported by the template, whole: entries about a sealed item
// were written without its details (changelog.ts), so nothing needs blanking there.
import type { Tx } from '@/core/db/rls';
import { PRIVATE_LABEL, type Compartment } from './compartment';
import type { Lens } from './lens';
import { nobodyLens } from './seal';

const C = { privateToId: true, revealDays: true } as const;
type Rows = Promise<object[]>;
const keep = <T extends object>(rows: T[], L: Lens | null, f: (L: Lens, r: T) => object) => (L ? rows.map((r) => f(L, r)) : rows);

export async function exportTasks(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.task.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, include: { vendor: { select: C } } });
  return keep(rows, L, (L, { vendor, ...t }) => L.blank('task', t, [t, vendor]));
}

export async function exportExpenses(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.expense.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, include: { category: { select: C }, vendor: { select: C } } });
  return keep(rows, L, (L, { category, vendor, ...e }) => L.blank('expense', e, [e, category, vendor]));
}

export async function exportCategories(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  return keep(await tx.budgetCategory.findMany({ where: { orgId } }), L, (L, c) => L.blank('category', c, [c]));
}

export async function exportVendors(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  return keep(await tx.vendor.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }), L, (L, v) => L.blank('vendor', v, [v]));
}

export async function exportVendorPayments(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.vendorPayment.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, include: { vendor: { select: C } } });
  return keep(rows, L, (L, { vendor, ...p }) => L.blankFields(p, [vendor], { label: '' }));
}

export async function exportVendorBriefs(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.vendorBrief.findMany({ where: { orgId }, orderBy: { generatedAt: 'asc' }, include: { vendor: { select: C } } });
  return keep(rows, L, (L, { vendor, ...b }) => L.blankFields(b, [vendor], { body: '' }));
}

export async function exportVendorAttachments(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.vendorAttachment.findMany({ where: { orgId }, omit: { bytes: true }, orderBy: { createdAt: 'asc' }, include: { vendor: { select: C } } });
  return keep(rows, L, (L, { vendor, ...a }) => L.blankFields(a, [vendor], { label: '' }));
}

/** A baseline's frozen task titles: a task sealed now is "Private task" (one written while it was shared included). */
export async function exportBaselines(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.scheduleBaseline.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  if (!L) return rows;
  const tasks = await tx.task.findMany({ where: { orgId }, select: { id: true, title: true, ...C, vendor: { select: C } } });
  const titles = L.titles(tasks);
  return rows.map((b) => {
    const snap = b.snapshot as { tasks?: Record<string, { title?: string }> } | null;
    if (!snap?.tasks) return b;
    const masked = Object.fromEntries(Object.entries(snap.tasks).map(([id, t]) => [id, titles.get(id) === PRIVATE_LABEL.task ? { ...t, title: PRIVATE_LABEL.task } : t]));
    return { ...b, snapshot: { ...snap, tasks: masked } };
  });
}

/** A budget snapshot's frozen category lines: a category sealed now is a masked line (the totals stay). */
export async function exportBudgetSnapshots(tx: Tx, orgId: string): Rows {
  const L = await nobodyLens(tx, orgId);
  const rows = await tx.budgetSnapshot.findMany({ where: { orgId }, orderBy: { takenAt: 'asc' } });
  if (!L) return rows;
  const cats = new Map<string, Compartment>((await tx.budgetCategory.findMany({ where: { orgId }, select: { id: true, ...C } })).map((c) => [c.id, c]));
  return rows.map((s) => {
    const totals = s.totals as { lines?: { id: string }[] } | null;
    if (!totals?.lines) return s;
    return { ...s, totals: { ...totals, lines: totals.lines.map((l) => (L.hides([cats.get(l.id)]) ? { id: l.id, name: PRIVATE_LABEL.category, private: true } : l)) } };
  });
}
