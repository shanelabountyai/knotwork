import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays } from '@/lib/knotwork/days';
import { addMonths, anniversary, coveredBy, dayAt, EVERY_MAX, nextAnniversary, nextDue, ordinal, ruleText, validRule, type Rule } from '@/lib/knotwork/lifeadmin/recurrence';
import { regenerateLife, type LifeFx } from '../../scripts/knotwork/gen-fixtures';
import { readJson, ROOT } from './fixtures';

// Phase 5, life-admin mode without a database: anniversaries and recurring household tasks. RULE 1 extended to
// recurrence: a task stores a rule and the days it was done; when it is next due is computed here, never stored. The
// fixtures' expect blocks are written by lifeadmin/recurrence.ts (npm run fixtures:check) and recomputed independently
// by tools/recurrence_oracle.py under pytest.
const DIR = 'fixtures/lifeadmin';
const files = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.json')).sort();

describe('life-admin fixtures', () => {
  it('there are at least nine, covering every unit and every state', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    const all = files.map((f) => readJson<LifeFx & { expect: { tasks: { state: string }[] } }>(`${DIR}/${f}`));
    expect(new Set(all.flatMap((fx) => fx.tasks.map((t) => t.rule.unit)))).toEqual(new Set(['day', 'week', 'month', 'anniversary']));
    expect(new Set(all.flatMap((fx) => fx.expect.tasks.map((t) => t.state)))).toEqual(new Set(['overdue', 'today', 'soon', 'later']));
  });
  it.each(files)('%s is what the engine computes, byte for byte', (f) => {
    expect(regenerateLife(readJson<LifeFx>(`${DIR}/${f}`))).toBe(readFileSync(join(ROOT, DIR, f), 'utf8'));
  });
});

describe('month steps clamp to the month end', () => {
  it('Jan 31 + 1 month is Feb 28, or Feb 29 in a leap year; each step starts from the day it was really done', () => {
    expect([addMonths('2027-01-31', 1), addMonths('2028-01-31', 1), addMonths('2027-02-28', 1), addMonths('2027-12-31', 2), addMonths('2028-03-31', -1)]).toEqual(['2027-02-28', '2028-02-29', '2027-03-28', '2028-02-29', '2028-02-29']);
    expect(nextDue({ unit: 'month', every: 1 }, '2026-10-01', ['2027-01-31'], '2027-02-01').due).toBe('2027-02-28');
    expect(nextDue({ unit: 'month', every: 1 }, '2026-10-01', ['2027-01-31', '2027-02-28'], '2027-03-01').due).toBe('2027-03-28');
  });
  it('a year of month steps from every day of a leap year never leaves the calendar', () => {
    for (let d = '2028-01-01'; d < '2029-01-01'; d = addDays(d, 1)) {
      for (const n of [1, 2, 6, 12, 13, 24]) {
        const out = addMonths(d, n);
        expect(Number(out.slice(8)), `${d} + ${n}`).toBeLessThanOrEqual(Number(d.slice(8)));
        expect(addDays(out, 0)).toBe(out); // a real day
      }
    }
  });
});

describe('anniversaries', () => {
  it('a Feb 29 wedding is remembered on Feb 28, and on Feb 29 in leap years', () => {
    expect([1, 2, 3, 4, 8].map((k) => anniversary('2028-02-29', k))).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29', '2036-02-29']);
  });
  it('the next one counts today, is never the wedding day, and says which it is', () => {
    expect(nextAnniversary('2026-10-10', '2026-10-11')).toEqual({ k: 1, day: '2027-10-10', inDays: 364, today: false, label: '1st anniversary' });
    expect(nextAnniversary('2026-10-10', '2027-10-10')).toMatchObject({ k: 1, today: true, inDays: 0 });
    expect(nextAnniversary('2026-10-10', '2027-10-11')).toMatchObject({ k: 2, day: '2028-10-10' });
    expect(nextAnniversary('2026-10-10', '2026-10-10')).toMatchObject({ k: 1 }); // the wedding day itself is not an anniversary
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th', '112th']);
  });
  it('a done day counts for the nearest anniversary; the days after the wedding count for the wedding day', () => {
    expect([coveredBy('2026-09-12', '2026-09-14'), coveredBy('2026-09-12', '2027-09-09'), coveredBy('2026-09-12', '2027-09-17'), coveredBy('2026-09-12', '2027-03-13'), coveredBy('2026-09-12', '2027-03-14')]).toEqual([0, 1, 1, 0, 1]);
  });
});

describe('next due', () => {
  const wedding = '2026-10-10';
  it('never done: an interval task is due today; an anniversary task on the next anniversary', () => {
    expect(nextDue({ unit: 'week', every: 2 }, wedding, [], '2027-01-05')).toEqual({ due: '2027-01-05', never: true, lastDone: null, state: 'today', overdueDays: 0 });
    expect(nextDue({ unit: 'anniversary', every: 1 }, wedding, [], '2027-01-05')).toMatchObject({ due: '2027-10-10', never: true, state: 'later' });
  });
  it('a day after today is not a fact yet; order and repeats do not matter', () => {
    const r: Rule = { unit: 'day', every: 10 };
    expect(nextDue(r, wedding, ['2027-01-01', '2027-01-20', '2026-12-25', '2027-01-01'], '2027-01-10').lastDone).toBe('2027-01-01');
    expect(nextDue(r, wedding, ['2027-01-20'], '2027-01-10')).toMatchObject({ never: true, due: '2027-01-10' });
  });
  it('the states: overdue, today, soon (within 7 days), later', () => {
    const r: Rule = { unit: 'day', every: 30 };
    expect(['2026-12-01', '2026-12-11', '2026-12-15', '2027-01-05'].map((done) => nextDue(r, wedding, [done], '2027-01-10').state)).toEqual(['overdue', 'today', 'soon', 'later']);
  });
  it('the day is the wall-clock day in the wedding\'s time zone, across both daylight-saving changes', () => {
    expect(dayAt('America/Chicago', new Date('2027-03-15T05:30:00Z'))).toBe('2027-03-15'); // CDT: 00:30
    expect(dayAt('America/Chicago', new Date('2027-11-08T05:30:00Z'))).toBe('2027-11-07'); // CST: 23:30
    // A step of 7 days across the spring change is still 7 calendar days (no hour is lost from a day).
    expect(nextDue({ unit: 'week', every: 1 }, wedding, ['2027-03-10'], '2027-03-17').due).toBe('2027-03-17');
  });
  it('rules are bounded: 1 to 365 days, 52 weeks, 24 months; the anniversary is once a year', () => {
    expect(EVERY_MAX).toEqual({ day: 365, week: 52, month: 24, anniversary: 1 });
    expect([validRule({ unit: 'day', every: 365 }), validRule({ unit: 'day', every: 366 }), validRule({ unit: 'week', every: 0 }), validRule({ unit: 'month', every: 1.5 }), validRule({ unit: 'anniversary', every: 2 })]).toEqual([true, false, false, false, false]);
    expect([ruleText({ unit: 'week', every: 1 }), ruleText({ unit: 'month', every: 3 }), ruleText({ unit: 'anniversary', every: 1 })]).toEqual(['every week', 'every 3 months', 'every year, on the anniversary']);
  });
});
