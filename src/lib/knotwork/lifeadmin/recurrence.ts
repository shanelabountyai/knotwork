// Phase 5, life-admin mode: anniversaries and recurring household tasks. PURE: no database and no clock; "today" is
// an argument (the caller takes it from the wedding's time zone, context.ts todayOf, so a daylight-saving change never
// moves a day). RULE 1 extended to recurrence: a task stores a rule and the days it was done (dates of fact); when it is
// next due is worked out here on every read and never stored. tools/recurrence_oracle.py recomputes every fixture in
// fixtures/lifeadmin/ with no shared code (D-145, D-146).
import { addDays, diffDays, isRealDay, todayIn, type Day } from '../days';

export const UNITS = ['day', 'week', 'month', 'anniversary'] as const;
export type Unit = (typeof UNITS)[number];
export type Rule = { unit: Unit; every: number };

/** How far apart a rule may space its days. The anniversary comes once a year: `every` is 1. */
export const EVERY_MAX: Record<Unit, number> = { day: 365, week: 52, month: 24, anniversary: 1 };
export const UNIT_LABEL: Record<Unit, string> = { day: 'days', week: 'weeks', month: 'months', anniversary: 'year, on the anniversary' };

export const validRule = (r: Rule): boolean => Number.isInteger(r.every) && r.every >= 1 && r.every <= EVERY_MAX[r.unit];

const ymd = (d: Day) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) });
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y: number, m: number) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/** `n` calendar months after `d`, on the same day of the month, or the month's last day when it is shorter (Jan 31 + 1 → Feb 28 or 29). */
export function addMonths(d: Day, n: number): Day {
  const { y, m, d: day } = ymd(d);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return `${pad(ny, 4)}-${pad(nm)}-${pad(Math.min(day, monthDays(ny, nm)))}`;
}

/** The k-th anniversary of a wedding (k = 0 is the wedding day). A Feb 29 wedding is remembered on Feb 28 in other years. */
export const anniversary = (wedding: Day, k: number): Day => addMonths(wedding, 12 * k);

/** "1st", "2nd", "3rd", "11th", "21st", "112th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

export type NextAnniversary = { k: number; day: Day; inDays: number; today: boolean; label: string };

/** The next anniversary on or after `today` (today itself counts: "today is your 1st anniversary"). Never the wedding day. */
export function nextAnniversary(wedding: Day, today: Day): NextAnniversary {
  let k = Math.max(1, ymd(today).y - ymd(wedding).y - 1);
  while (anniversary(wedding, k) < today) k++;
  const day = anniversary(wedding, k);
  return { k, day, inDays: diffDays(day, today), today: day === today, label: `${ordinal(k)} anniversary` };
}

/** One step of a rule from a day it was done. The anniversary rule has no step from a day; see nextDue. */
export function step(r: Rule, from: Day): Day {
  if (r.unit === 'day') return addDays(from, r.every);
  if (r.unit === 'week') return addDays(from, 7 * r.every);
  if (r.unit === 'month') return addMonths(from, r.every);
  throw new Error('the anniversary rule is not stepped from a day');
}

/** Which anniversary a done day counts for: the nearest one (0 is the wedding day; halfway between, the later one). */
export function coveredBy(wedding: Day, done: Day): number {
  if (done <= wedding) return 0;
  const after = nextAnniversary(wedding, done).k;
  const before = after - 1;
  return diffDays(done, anniversary(wedding, before)) < diffDays(anniversary(wedding, after), done) ? before : after;
}

export type Due = {
  /** The day it is next due. */
  due: Day;
  /** Never done: an interval task is due at once; an anniversary task is due on the next anniversary. */
  never: boolean;
  /** The last day it was done, if ever. */
  lastDone: Day | null;
  state: 'overdue' | 'today' | 'soon' | 'later';
  /** today - due: positive when overdue, 0 on the day, negative before it. */
  overdueDays: number;
};

/** Within this many days, a task shows as coming up soon. */
export const SOON_DAYS = 7;

/**
 * When a task is next due, from its rule, the wedding date and the days it was done (any order; duplicates and days
 * after today are ignored: a date of fact is never in the future). Nothing here is stored.
 *  - every N days/weeks/months: N after the last day it was done (month ends clamp); never done: due today.
 *  - yearly on the anniversary: a done day covers the anniversary nearest to it (a few days early or late counts for
 *    that year; the wedding day itself is anniversary 0), so it is next due on the one after; never done: the next
 *    anniversary from today.
 */
export function nextDue(r: Rule, wedding: Day, done: readonly Day[], today: Day): Due {
  const past = done.filter((d) => isRealDay(d) && d <= today);
  const lastDone = past.length ? past.reduce((a, b) => (a > b ? a : b)) : null;
  let due: Day;
  if (r.unit === 'anniversary') {
    if (lastDone === null) due = nextAnniversary(wedding, today).day;
    else due = anniversary(wedding, coveredBy(wedding, lastDone) + 1);
  } else due = lastDone === null ? today : step(r, lastDone);
  const overdueDays = diffDays(today, due);
  const state = overdueDays > 0 ? 'overdue' : overdueDays === 0 ? 'today' : -overdueDays <= SOON_DAYS ? 'soon' : 'later';
  return { due, never: lastDone === null, lastDone, state, overdueDays };
}

/** The calendar day at an instant in the wedding's time zone (the scheduler's "today"); re-exported for the fixtures. */
export const dayAt = (timeZone: string, at: Date): Day => todayIn(timeZone, at);

/** "every 3 months", "every week", "every year, on the anniversary". */
export function ruleText(r: Rule): string {
  if (r.unit === 'anniversary') return 'every year, on the anniversary';
  const one = { day: 'day', week: 'week', month: 'month' }[r.unit];
  return r.every === 1 ? `every ${one}` : `every ${r.every} ${UNIT_LABEL[r.unit]}`;
}
