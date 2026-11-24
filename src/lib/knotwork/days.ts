// Whole calendar days as 'YYYY-MM-DD' strings. PURE: no clock and no time zone in here, except todayIn, which takes
// both as arguments. The scheduler never sees a time of day, so a day is the same day everywhere.

export type Day = string; // 'YYYY-MM-DD'

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS = 86_400_000;

const toNum = (d: Day) => Math.round(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / MS);
const fromNum = (n: number): Day => new Date(n * MS).toISOString().slice(0, 10);

/** A string shaped like a day that is also a day on the calendar (no February 30th). */
export const isRealDay = (d: string): d is Day => DAY_RE.test(d) && fromNum(toNum(d)) === d;

export const addDays = (d: Day, n: number): Day => fromNum(toNum(d) + n);

/** a minus b, in days. */
export const diffDays = (a: Day, b: Day): number => toNum(a) - toNum(b);

/** The calendar day it is at `at` in an IANA time zone. */
export function todayIn(timeZone: string, at: Date): Day {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A Postgres DATE column (read by Prisma as UTC midnight) to a day, and back. */
export const dayOfDb = (d: Date): Day => d.toISOString().slice(0, 10);
export const dbOfDay = (d: Day): Date => new Date(`${d}T00:00:00Z`);

/** 'Sat, Oct 9, 2027' for people. */
export const showDay = (d: Day) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(dbOfDay(d));
