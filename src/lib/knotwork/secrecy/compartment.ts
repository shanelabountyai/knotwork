// P1-1 secrecy compartments (ADR-001): the rules, as pure functions. PURE.
//
// A task, an expense, a vendor or a budget category may be "private to me until" a reveal point. The reveal point is a
// whole number of days after the wedding date (negative: before; 0: the wedding day) or "never" (null: revealed only by
// hand). No date is stored (rule 1, D-92): the reveal day is worked out from the wedding date on every read, so it
// moves with the wedding.
//
// An item is SEALED (private to someone, right now) while it has an owner who is still a partner and the reveal day has
// not come. It is HIDDEN from a viewer when any compartment it sits in is sealed and is not the viewer's own: its own,
// and the ones it inherits (a payment task from its vendor, an expense from its category and its vendor).
import { addDays, type Day } from '../days';

export type Compartment = { privateToId: string | null; revealDays: number | null };
/** Who is looking, and what "now" is. A viewerId of '' is nobody: every sealed compartment hides (the data export). */
export type Seen = { viewerId: string; partners: readonly string[]; weddingDay: Day; today: Day };
export type ItemKind = 'task' | 'expense' | 'vendor' | 'category';

export const REVEAL_MIN = -3650;
export const REVEAL_MAX = 3650;
export const SHARED: Compartment = { privateToId: null, revealDays: null };
export const NOBODY = '';

/** The day the item reveals itself, or null for "only by hand". */
export const revealDayOf = (weddingDay: Day, revealDays: number | null): Day | null => (revealDays === null ? null : addDays(weddingDay, revealDays));

/**
 * Private to someone, right now. An owner who is no longer a partner holds no secret (D-96): the item is shared, so
 * nothing stays out of every total and every plan with nobody left who can see it.
 */
export function sealed(c: Compartment | null | undefined, s: Omit<Seen, 'viewerId'>): boolean {
  if (!c?.privateToId || !s.partners.includes(c.privateToId)) return false;
  const day = revealDayOf(s.weddingDay, c.revealDays);
  return day === null || s.today < day;
}

export type Why = { owner: string; revealsOn: Day | null };

/** Why an item is hidden from this viewer (the first sealed compartment that is not theirs), or null when it is not. */
export function hiddenBy(cs: readonly (Compartment | null | undefined)[], s: Seen): Why | null {
  for (const c of cs) if (c && sealed(c, s) && c.privateToId !== s.viewerId) return { owner: c.privateToId!, revealsOn: revealDayOf(s.weddingDay, c.revealDays) };
  return null;
}
export const hides = (cs: readonly (Compartment | null | undefined)[], s: Seen): boolean => hiddenBy(cs, s) !== null;

/** The viewer's own seal on an item (for "private to you until …"), or null. Only the item's own compartment. */
export function ownSeal(c: Compartment, s: Seen): Why | null {
  return sealed(c, s) && c.privateToId === s.viewerId ? { owner: s.viewerId, revealsOn: revealDayOf(s.weddingDay, c.revealDays) } : null;
}

/**
 * The privacy field on a form: '' (shared), 'never' (until revealed by hand), or a whole number of days relative to
 * the wedding date. Returns null for anything else.
 */
export type Privacy = { private: false } | { private: true; revealDays: number | null };
export function parsePrivacy(v: string | number): Privacy | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= REVEAL_MIN && v <= REVEAL_MAX ? { private: true, revealDays: v } : null;
  const t = v.trim();
  if (t === '') return { private: false };
  if (t === 'never') return { private: true, revealDays: null };
  if (!/^-?\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= REVEAL_MIN && n <= REVEAL_MAX ? { private: true, revealDays: n } : null;
}

/** The choices the forms offer (any whole number in range is accepted). */
export const PRIVACY_CHOICES: readonly { value: string; text: string }[] = [
  { value: '', text: 'Shared' },
  { value: '0', text: 'Private to me until the wedding day' },
  { value: '-1', text: 'Private to me until the day before' },
  { value: '-7', text: 'Private to me until a week before' },
  { value: '-30', text: 'Private to me until a month before' },
  { value: '1', text: 'Private to me until the day after' },
  { value: 'never', text: 'Private to me until I reveal it' },
];

/** "the wedding day", "30 days before the wedding", "until revealed by hand". */
export function revealText(revealDays: number | null): string {
  if (revealDays === null) return 'until revealed by hand';
  if (revealDays === 0) return 'until the wedding day';
  const n = Math.abs(revealDays);
  return `until ${n} day${n === 1 ? '' : 's'} ${revealDays < 0 ? 'before' : 'after'} the wedding`;
}

/** What stands in for a hidden item's label, everywhere. */
export const PRIVATE_LABEL: Record<ItemKind, string> = { task: 'Private task', expense: 'Private spend', vendor: 'Private vendor', category: 'Private category' };
/** What the change log stores instead of the label of an entry about a sealed item (ADR-001, "the change log"). */
export const PRIVATE_ENTRY = 'a private item';
