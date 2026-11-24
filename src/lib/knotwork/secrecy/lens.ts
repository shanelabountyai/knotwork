// P1-1 (ADR-001): THE masking function. PURE.
//
// Every view of a task, an expense, a vendor or a budget category that someone other than its owner may see passes
// through `lens(seen)`: the pages (through secrecy/views.ts), the activity feed, the move preview, the brief's task
// list, the stored snapshots and the data export. A hidden item comes out as a masked line: its kind, whose it is and
// when it reveals itself; never its label, vendor name, notes or figures. Totals are computed from the rows BEFORE they
// are masked, so a hidden amount still counts in every total. tests/knotwork/structure.test.ts pins this file as the
// only maker of a masked line.
import type { Day } from '../days';
import { hiddenBy, ownSeal, PRIVATE_ENTRY, PRIVATE_LABEL, type Compartment, type ItemKind, type Seen, type Why } from './compartment';

export type Hidden = { hidden: true; kind: ItemKind; label: string; owner: string; revealsOn: Day | null };
export type Shown<T> = { hidden: false; row: T; mine: Why | null };
export type Lensed<T> = Hidden | Shown<T>;

type C = Compartment;
export type TaskLike = C & { id: string; title: string; vendor?: C | null };
export type ExpenseLike = C & { category: C; vendor?: C | null };
export type LogData = { label?: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; private?: boolean };

/** Fields of each item that carry what it is. A hidden item never shows them; a stored or exported copy blanks them. */
const LABEL_FIELDS = {
  task: { title: PRIVATE_LABEL.task, notes: '' },
  expense: { description: PRIVATE_LABEL.expense },
  vendor: { name: PRIVATE_LABEL.vendor, contactName: '', email: '', phone: '', notes: '', deliverables: '' },
  category: { name: PRIVATE_LABEL.category },
} as const;

export function lens(seen: Seen) {
  const one = <T>(kind: ItemKind, row: T, own: C, inherited: readonly (C | null | undefined)[] = []): Lensed<T> => {
    const why = hiddenBy([own, ...inherited], seen);
    return why ? { hidden: true, kind, label: PRIVATE_LABEL[kind], ...why } : { hidden: false, row, mine: ownSeal(own, seen) };
  };
  const task = <T extends TaskLike>(t: T) => one('task', t, t, [t.vendor]);
  const blankFields = <T extends object>(row: T, cs: readonly (C | null | undefined)[], fields: Readonly<Record<string, string>>): T => {
    if (!hiddenBy(cs, seen)) return row;
    return { ...row, ...Object.fromEntries(Object.entries(fields).filter(([k]) => k in row)) };
  };
  const titles = (rows: readonly TaskLike[]): Map<string, string> => new Map(rows.map((t) => [t.id, task(t).hidden ? PRIVATE_LABEL.task : t.title]));
  return {
    seen,
    /** Is anything in `cs` hidden from this viewer? (A ref to a hidden item is a 404 to them, like a missing row.) */
    hides: (cs: readonly (C | null | undefined)[]) => hiddenBy(cs, seen) !== null,
    task,
    vendor: <T extends C>(v: T) => one('vendor', v, v),
    category: <T extends C>(c: T) => one('category', c, c),
    expense: <T extends ExpenseLike>(e: T) => one('expense', e, e, [e.category, e.vendor]),
    /** Any row that belongs to a vendor (a payment, a flag, a brief, an attachment): hidden with its vendor. */
    ofVendor: <T>(row: T, vendor: C) => one('vendor', row, { privateToId: null, revealDays: null }, [vendor]),
    /** Any row that belongs to a category (a pledge): hidden with its category. */
    ofCategory: <T>(row: T, category: C) => one('category', row, { privateToId: null, revealDays: null }, [category]),

    /** Task titles by id, a hidden one as "Private task": for dependency lists, the critical path and move previews. */
    titles,
    /** A plan (or a move preview's plan) with hidden titles replaced. */
    plan<P extends { id: string; title: string }>(plan: readonly P[], rows: readonly TaskLike[]): P[] {
      const t = titles(rows);
      return plan.map((p) => ({ ...p, title: t.get(p.id) ?? p.title }));
    },

    /**
     * A change-log entry as this viewer may read it. An entry about a hidden item keeps who and when and loses what:
     * no label, no before, no after. Entries written while the item was sealed were stored that way already
     * (changelog.ts); this also covers entries written before it became private.
     */
    entry(data: LogData, cs: readonly (C | null | undefined)[]): { label: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; masked: boolean } {
      if (data.private || hiddenBy(cs, seen)) return { label: PRIVATE_ENTRY, before: null, after: null, masked: true };
      return { label: data.label ?? '', before: data.before ?? null, after: data.after ?? null, masked: false };
    },

    /**
     * A copy for a stored artifact or the export: the same row with what it is blanked when it is hidden from this
     * viewer (for the export, the viewer is nobody). Ids, amounts and dates of fact stay, so the totals still add up.
     */
    blank<T extends object>(kind: ItemKind, row: T, cs: readonly (C | null | undefined)[]): T {
      return blankFields(row, cs, LABEL_FIELDS[kind]);
    },
    /** The same for a row that belongs to a hidden item (a payment's label, a brief's body, an attachment's label). */
    blankFields,
  };
}
export type Lens = ReturnType<typeof lens>;
