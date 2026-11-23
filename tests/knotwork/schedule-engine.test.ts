import { describe, expect, it } from 'vitest';
import { addDays, diffDays, isRealDay } from '@/lib/knotwork/days';
import { computeSchedule, criticalPath, fingerprint, previewMove, validatePlan, type PlanTask } from '@/lib/knotwork/schedule/engine';
import { scheduleFixture, scheduleFixtures } from './fixtures';

// P0-1 fixtures: cascade correctness, critical-path identification, impossible-runway detection.
// The expected values are also recomputed by an independent Python oracle (tools/schedule_oracle.py, pytest).
const task = (id: string, leadDays: number, bufferDays: number, dependsOn: string[] = [], done = false): PlanTask => ({ id, title: id, leadDays, bufferDays, dependsOn, done });

describe('days', () => {
  it('adds and subtracts whole days across months, years and a leap day', () => {
    expect(addDays('2027-10-09', -14)).toBe('2027-09-25');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(diffDays('2027-11-20', '2027-10-09')).toBe(42);
    expect(diffDays('2026-11-23', '2027-01-22')).toBe(-60);
  });
  it('knows a real calendar day from a shaped string', () => {
    expect(isRealDay('2027-02-28')).toBe(true);
    expect(isRealDay('2027-02-30')).toBe(false);
    expect(isRealDay('2027-13-01')).toBe(false);
    expect(isRealDay('27-1-1')).toBe(false);
  });
});

describe('scheduler fixtures', () => {
  it('finds them', () => {
    expect(scheduleFixtures.length).toBeGreaterThanOrEqual(16);
  });

  it.each(scheduleFixtures.map((f) => [f.name, f] as const))('%s: dates, states, critical path', (_, f) => {
    expect(computeSchedule(f.tasks, f.weddingDate, f.today)).toEqual(f.expect);
  });

  it.each(scheduleFixtures.filter((f) => f.move).map((f) => [f.name, f] as const))('%s: the move preview', (_, f) => {
    expect(previewMove(f.tasks, f.weddingDate, f.move!.to, f.today)).toEqual(f.move!.expect);
  });
});

describe('cascade correctness, worked by hand', () => {
  it('01: due = wedding - buffer, start-by = due - lead', () => {
    // 2027-10-09 minus 14 days = 2027-09-25; minus 30 more = 2027-08-26.
    const s = computeSchedule([task('book-band', 30, 14)], '2027-10-09', '2026-11-23');
    expect(s.tasks!['book-band']).toMatchObject({ due: '2027-09-25', startBy: '2027-08-26', state: 'ok', needDays: 44 });
  });

  it("02: the PRD's dress example: alterations need 3 months, so the order lands months earlier", () => {
    // alterations: due 2027-09-25 (14 days before), start-by 90 days earlier = 2027-06-27.
    // order-dress must be finished by then: due 2027-06-27, start-by 150 days earlier = 2027-01-28.
    // choose-dress must be finished by then: due 2027-01-28, start-by 30 days earlier = 2026-12-29.
    const s = computeSchedule(scheduleFixture('02-dress-chain').tasks, '2027-10-09', '2026-11-23');
    expect(s.tasks!.alterations).toMatchObject({ due: '2027-09-25', startBy: '2027-06-27' });
    expect(s.tasks!['order-dress']).toMatchObject({ due: '2027-06-27', startBy: '2027-01-28' });
    expect(s.tasks!['choose-dress']).toMatchObject({ due: '2027-01-28', startBy: '2026-12-29', slackDays: 36 });
    expect(s.criticalPath).toEqual(['choose-dress', 'order-dress', 'alterations']);
    expect(s.runwayDays).toBe(30 + 150 + 90 + 14);
  });

  it('a dependency never ends after its dependent starts (every fixture)', () => {
    for (const f of scheduleFixtures.filter((x) => !x.expect.invalid)) {
      const s = computeSchedule(f.tasks, f.weddingDate, f.today);
      for (const t of f.tasks) for (const d of t.dependsOn) if (!t.done) expect(diffDays(s.tasks![t.id]!.startBy, s.tasks![d]!.due), `${f.name}: ${d} -> ${t.id}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('no task is due after the wedding, and every date is a real day (every fixture)', () => {
    for (const f of scheduleFixtures.filter((x) => !x.expect.invalid)) {
      const s = computeSchedule(f.tasks, f.weddingDate, f.today);
      for (const t of Object.values(s.tasks!)) {
        expect(isRealDay(t.due) && isRealDay(t.startBy)).toBe(true);
        expect(diffDays(f.weddingDate, t.due)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('impossible-runway detection', () => {
  it('07: due is still ahead, but the lead time no longer fits', () => {
    // Wedding 2027-01-22, buffer 30 → due 2026-12-23. Lead 45 → start-by 2026-11-08. Today is 2026-11-23: 15 days short.
    const s = computeSchedule([task('custom-suit', 45, 30)], '2027-01-22', '2026-11-23');
    expect(s.tasks!['custom-suit']).toEqual({ due: '2026-12-23', startBy: '2026-11-08', earliestStart: '2026-11-23', slackDays: -15, needDays: 75, state: 'impossible' });
    expect(s.marginDays).toBe(-15);
  });

  it('late and impossible are different: late is past due, impossible is still ahead but cannot fit', () => {
    const s = computeSchedule([task('late-one', 5, 40), task('tight-one', 30, 10)], '2026-12-23', '2026-11-23');
    expect(s.tasks!['late-one']!.state).toBe('late'); // due 2026-11-13
    expect(s.tasks!['tight-one']!.state).toBe('impossible'); // due 2026-12-13, start-by 2026-11-13
  });

  it('exactly enough runway is ok, one day less is impossible', () => {
    expect(computeSchedule([task('a', 60, 0)], '2027-01-22', '2026-11-23').tasks!.a!.state).toBe('ok'); // 60 days of runway
    expect(computeSchedule([task('a', 61, 0)], '2027-01-22', '2026-11-23').tasks!.a!.state).toBe('impossible');
  });

  it('a finished task is never late or impossible, and does not hold up what depends on it', () => {
    const s = computeSchedule([task('a', 400, 0, [], true), task('b', 10, 0, ['a'])], '2027-01-22', '2026-11-23');
    expect(s.tasks!.a!.state).toBe('done');
    expect(s.tasks!.b).toMatchObject({ state: 'ok', earliestStart: '2026-11-23' });
  });
});

describe('critical path', () => {
  it('is the longest chain back from the wedding, with a stable tie-break', () => {
    expect(criticalPath(scheduleFixture('16-critical-tie').tasks)).toEqual({ ids: ['m-start', 'a-branch'], runwayDays: 35 });
    expect(criticalPath(scheduleFixture('03-diamond').tasks).ids).toEqual(['pick-colours', 'order-flowers']);
  });
  it('does not depend on the wedding date or on today', () => {
    const f = scheduleFixture('09-move-later-6-weeks');
    expect(computeSchedule(f.tasks, f.weddingDate, f.today).criticalPath).toEqual(computeSchedule(f.tasks, '2030-06-01', '2029-01-01').criticalPath);
  });
  it('is empty when every task is finished', () => {
    expect(criticalPath([task('a', 5, 5, [], true)])).toEqual({ ids: [], runwayDays: 0 });
  });
});

describe('plans that cannot be scheduled', () => {
  it('names a cycle', () => {
    expect(validatePlan(scheduleFixture('13-cycle').tasks)).toEqual({ kind: 'cycle', ids: ['a', 'b', 'c'] });
    expect(validatePlan([task('a', 1, 0, ['a'])])).toEqual({ kind: 'cycle', ids: ['a'] });
  });
  it('names a missing dependency, a duplicate id and a negative number', () => {
    expect(validatePlan([task('a', 1, 0, ['ghost'])])).toEqual({ kind: 'missing-dependency', ids: ['a'] });
    expect(validatePlan([task('a', 1, 0), task('a', 2, 0)])).toEqual({ kind: 'duplicate-id', ids: ['a'] });
    expect(validatePlan([task('a', -1, 0)])).toEqual({ kind: 'negative-days', ids: ['a'] });
    expect(validatePlan([task('a', 1.5, 0)])).toEqual({ kind: 'negative-days', ids: ['a'] });
  });
  it('computeSchedule returns only the reason, no dates', () => {
    expect(computeSchedule([task('a', 1, 0, ['ghost'])], '2027-10-09', '2026-11-23')).toEqual({ invalid: { kind: 'missing-dependency', ids: ['a'] } });
  });
  it('previewMove throws on an invalid plan', () => {
    expect(() => previewMove([task('a', 1, 0, ['a'])], '2027-10-09', '2027-11-20', '2026-11-23')).toThrow(/cycle/);
  });
});

describe('date move preview', () => {
  const f = scheduleFixture('09-move-later-6-weeks');
  it('six weeks later: every open task shifts exactly 42 days and nothing breaks', () => {
    const p = previewMove(f.tasks, f.weddingDate, f.move!.to, f.today);
    expect(p.deltaDays).toBe(42);
    const before = computeSchedule(f.tasks, f.weddingDate, f.today).tasks!;
    for (const [id, t] of Object.entries(p.tasks)) {
      expect(diffDays(t.due, before[id]!.due), id).toBe(42);
      expect(diffDays(t.startBy, before[id]!.startBy), id).toBe(42);
    }
    expect(p.late).toEqual([]);
    expect(p.impossible).toEqual([]);
  });
  it('zero orphans: every task of the plan is in the preview, with dates', () => {
    for (const fx of scheduleFixtures.filter((x) => x.move)) {
      const p = previewMove(fx.tasks, fx.weddingDate, fx.move!.to, fx.today);
      expect(Object.keys(p.tasks).sort()).toEqual(fx.tasks.map((t) => t.id).sort());
    }
  });
  it('an earlier date says what is now late and now impossible, and which of those are new', () => {
    const fx = scheduleFixture('10-move-earlier');
    const p = previewMove(fx.tasks, fx.weddingDate, fx.move!.to, fx.today);
    expect(p.late).toEqual([{ id: 'engrave-rings', isNew: true }]);
    expect(p.impossible).toEqual([{ id: 'alterations', isNew: false }, { id: 'book-photographer', isNew: true }, { id: 'order-dress', isNew: false }]);
  });
  it('a later date lists what it resolves', () => {
    const fx = scheduleFixture('17-move-resolves');
    expect(previewMove(fx.tasks, fx.weddingDate, fx.move!.to, fx.today).resolved).toEqual(['custom-suit', 'order-rings']);
  });
  it('the fingerprint is 16 hex characters and changes with the date, a task or a state', () => {
    const a = previewMove(f.tasks, f.weddingDate, '2027-11-20', f.today);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(previewMove(f.tasks, f.weddingDate, '2027-11-21', f.today).fingerprint).not.toBe(a.fingerprint);
    expect(previewMove([...f.tasks, task('new', 1, 1)], f.weddingDate, '2027-11-20', f.today).fingerprint).not.toBe(a.fingerprint);
    expect(previewMove(f.tasks.map((t) => (t.id === 'order-cake' ? { ...t, done: true } : t)), f.weddingDate, '2027-11-20', f.today).fingerprint).not.toBe(a.fingerprint);
    expect(fingerprint('2027-11-20', a.tasks)).toBe(a.fingerprint);
  });
  it('the same inputs always give the same preview (no clock, no randomness)', () => {
    expect(previewMove(f.tasks, f.weddingDate, f.move!.to, f.today)).toEqual(previewMove([...f.tasks].reverse(), f.weddingDate, f.move!.to, f.today));
  });
});
