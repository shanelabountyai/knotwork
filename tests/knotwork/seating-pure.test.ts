import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskFigures, percentOf } from '@/lib/knotwork/dashboard/figures';
import { generate, infeasibility, prng, problemErrors, reasonText, score, violationText, WEIGHT, type PairRule, type Problem } from '@/lib/knotwork/seating/engine';
import { linkLastDay, linkWorks, vendorLinkView, VENDOR_LINK_DAYS_AFTER } from '@/lib/knotwork/vendors/projection';
import { regenerateSeating, type SeatingFx } from '../../scripts/knotwork/gen-fixtures';
import { readJson, ROOT } from './fixtures';

// P1-5, the seating engine (generate → score → repair), without a database. The fixtures in fixtures/seating/ are
// re-derived here and re-scored (and, being small, solved by brute force) by tools/seating_oracle.py under pytest.
const FIXTURES = readdirSync(join(ROOT, 'fixtures/seating')).filter((f) => f.endsWith('.json')).sort();
const fx = (name: string) => readJson<SeatingFx>(`fixtures/seating/${FIXTURES.find((f) => f.startsWith(name))!}`);
const problemOf = (f: SeatingFx): Problem => ({ tables: f.tables, guests: f.guests, rules: f.rules, locked: f.locked });
const names = { guest: (id: string) => id, table: (id: string) => id, household: (id: string) => id };

/** A big reception: 200 guests in households of one to four, 20 tables of ten (exactly 200 seats), 40 pair rules. */
function reception(seed: number, tables = 20, capacity = 10): Problem {
  const r = prng(seed);
  const guests: Problem['guests'] = [];
  for (let h = 0; guests.length < 200; h++) {
    const n = Math.min(200 - guests.length, 1 + Math.floor(r() * 4));
    for (let k = 0; k < n; k++) guests.push({ id: `g${String(guests.length).padStart(3, '0')}`, name: `Guest ${guests.length}`, household: `h${h}` });
  }
  const rules: PairRule[] = [];
  const seen = new Set<string>();
  while (rules.length < 40) {
    const [a, b] = [Math.floor(r() * 200), Math.floor(r() * 200)];
    const key = [a, b].sort().join();
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    rules.push({ a: guests[a]!.id, b: guests[b]!.id, kind: rules.length % 2 ? 'apart' : 'together', hard: rules.length % 3 === 0 });
  }
  return { tables: Array.from({ length: tables }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, name: `Table ${i + 1}`, capacity })), guests, rules, locked: {} };
}

describe('the fixtures', () => {
  it('there are known-optimal, known-infeasible and unsolvable cases', () => {
    const claims = FIXTURES.map((f) => fx(f.slice(0, 2)).claim);
    expect(claims.filter((c) => c === 'optimal').length).toBeGreaterThanOrEqual(6);
    expect(claims.filter((c) => c === 'infeasible').length).toBeGreaterThanOrEqual(3);
    expect(claims).toContain('unsolved');
  });
  it.each(FIXTURES)('%s: the engine reproduces its expect block exactly', (f) => {
    const text = JSON.stringify(readJson(`fixtures/seating/${f}`), null, 2) + '\n';
    expect(regenerateSeating(JSON.parse(text) as SeatingFx)).toBe(text);
  });
  it('an infeasible problem is reported with its reasons and no seats, never half-seated', () => {
    for (const name of ['06', '07', '08', '09']) {
      const r = generate(problemOf(fx(name)), 1);
      expect(r.status, name).toBe('infeasible');
      expect(r.seats).toEqual({});
      expect(r.score).toBeNull();
      expect(r.reasons.length).toBeGreaterThan(0);
    }
    expect(generate(problemOf(fx('06')), 1).reasons).toEqual([{ code: 'capacity', need: 7, have: 6 }]);
    expect(reasonText(generate(problemOf(fx('08')), 1).reasons[0]!, names)).toBe('amy and ann must sit apart, but the "together" rules put them at one table.');
  });
  it('an unsolvable one is "unsolved", and the rule it could not keep is named', () => {
    const r = generate(problemOf(fx('10')), 1);
    expect(r.status).toBe('unsolved');
    expect(r.score!.hard).toBe(1);
    expect(r.score!.violations.filter((v) => v.hard).map((v) => violationText(v, names))[0]).toMatch(/must sit apart, and both are at t\d\./);
  });
  it('a locked seat stays where it is', () => {
    const f = fx('04');
    expect(generate(problemOf(f), 1).seats.ruth).toBe('t2');
    for (const seed of [2, 3, 99]) expect(generate(problemOf(f), seed).seats.ruth).toBe('t2');
  });
});

describe('score', () => {
  const p: Problem = {
    tables: [{ id: 't1', name: 'One', capacity: 2 }, { id: 't2', name: 'Two', capacity: 2 }],
    guests: [{ id: 'a', name: 'A', household: 'h1' }, { id: 'b', name: 'B', household: 'h1' }, { id: 'c', name: 'C', household: 'h2' }],
    rules: [{ a: 'a', b: 'c', kind: 'apart', hard: true }, { a: 'b', b: 'c', kind: 'together', hard: false }],
    locked: {},
  };
  it('weighs hard problems far above any preference, and counts each kind', () => {
    expect(score(p, { a: 't1', b: 't1', c: 't2' })).toMatchObject({ hard: 0, soft: WEIGHT.pair, total: 3 });
    expect(score(p, { a: 't1', b: 't2', c: 't2' })).toMatchObject({ hard: 0, soft: WEIGHT.household, total: 2 });
    expect(score(p, { a: 't1', b: 't2', c: 't1' })).toMatchObject({ hard: 1, soft: WEIGHT.pair + WEIGHT.household, total: WEIGHT.hard + 5 });
    // Over capacity and no seat are hard too; a seat at a table that does not exist is no seat.
    expect(score(p, { a: 't1', b: 't1', c: 't1' }).violations.map((v) => v.code)).toEqual(['over', 'apart']); // b and c together: kept
    expect(score(p, { a: 't1', b: 't9' }).violations.map((v) => v.code)).toEqual(['unseated', 'unseated']);
  });
  it('problemErrors catches the shapes the store must never pass', () => {
    expect(problemErrors(p)).toEqual([]);
    expect(problemErrors({ ...p, rules: [...p.rules, { a: 'c', b: 'a', kind: 'together', hard: false }] })).toEqual(['rule a|c: twice']);
    expect(problemErrors({ ...p, rules: [{ a: 'a', b: 'a', kind: 'apart', hard: true }] })).toEqual(['rule a: a guest paired with themself']);
    expect(problemErrors({ ...p, tables: [{ id: 't1', name: 'x', capacity: 0 }] })).toEqual(['table t1: capacity']);
    expect(() => generate({ ...p, locked: { zz: 't1' } }, 1)).toThrow(/unknown guest or table/);
  });
  it('infeasibility proves only what it can, and lists every reason', () => {
    expect(infeasibility(p)).toEqual([]);
    expect(infeasibility({ ...p, locked: { a: 't1', c: 't1' } }).map((r) => r.code)).toEqual(['locked-apart']);
  });
});

describe('generate: reproducible, and within its time budget', () => {
  it('the same problem and seed give the same seating; another seed may differ but is as sound', () => {
    const p = reception(1);
    const one = generate(p, 7);
    expect(generate(p, 7)).toEqual(one);
    const other = generate(p, 8);
    expect(other.status).toBe('ok');
    expect(score(p, other.seats).hard).toBe(0);
  });
  it('200 guests at 20 tables: every guest seated, no table over, no hard rule broken, well inside two seconds', () => {
    for (const seed of [1, 2, 3]) {
      const p = reception(seed);
      const t0 = performance.now();
      const r = generate(p, seed);
      const ms = performance.now() - t0;
      expect(ms, `seed ${seed}: ${ms.toFixed(0)} ms`).toBeLessThan(2000);
      expect(r.status).toBe('ok');
      expect(Object.keys(r.seats)).toHaveLength(200);
      const per = new Map<string, number>();
      for (const t of Object.values(r.seats)) per.set(t, (per.get(t) ?? 0) + 1);
      expect(Math.max(...per.values())).toBeLessThanOrEqual(10);
      expect(r.score).toEqual(score(p, r.seats));
      // The repair improves on nothing worse than a plain household-by-household fill would leave: no household of
      // four or fewer is split more than the hard rules force.
      expect(r.score!.soft).toBeLessThan(200);
    }
  });
  it('with no room left over, a capacity shortfall of one is infeasible, not a seating with a guest standing', () => {
    const p = reception(4, 20, 10);
    expect(generate({ ...p, tables: p.tables.slice(1) }, 1)).toMatchObject({ status: 'infeasible', reasons: [{ code: 'capacity', need: 200, have: 190 }] });
  });
});

describe('the dashboard and vendor-link arithmetic', () => {
  it('"on track" is done or open with time; late and impossible are not; rounded down', () => {
    expect(taskFigures(['done', 'ok', 'ok', 'late', 'impossible', 'ok'])).toEqual({ total: 6, done: 1, onTrack: 3, late: 1, impossible: 1, onTrackPct: 66 });
    expect(taskFigures([])).toMatchObject({ onTrackPct: 100 });
    expect(taskFigures([...Array(199).fill('ok'), 'late'])).toMatchObject({ onTrackPct: 99 }); // never shows 100% with one overdue
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(233_000, 2_000_000)).toBe(11);
  });
  it('a vendor link works until a set number of days after the wedding, derived from its date', () => {
    expect(VENDOR_LINK_DAYS_AFTER).toBe(7);
    expect(linkLastDay('2027-10-23')).toBe('2027-10-30');
    expect(linkWorks('2027-10-23', '2027-10-30')).toBe(true);
    expect(linkWorks('2027-10-23', '2027-10-31')).toBe(false);
  });
  it('the vendor\'s view is three strings, and the brief in it is the role-filtered brief', () => {
    const view = vendorLinkView({
      wedding: { title: 'J & R', date: '2027-10-23' },
      vendor: { name: 'Spin Doctors', category: 'dj', contactName: '', deliverables: 'Five hours', arriveMin: null, departMin: null, countEstimate: 120, countDueDaysBefore: null, countDue: null, contractTotalCents: null, contractSignedOn: null },
      payments: [], tasks: [], openFlags: [],
      guests: { attending: 3, adults: 2, kids: 1, infants: 0, vendorMeals: 0, catererMeals: 3, meals: { Fish: 1 }, dietary: {}, accessibility: {}, songs: ['September'], doNotPlay: [{ title: 'Macarena', artist: '' }] },
    });
    expect(Object.keys(view).sort()).toEqual(['brief', 'vendorName', 'weddingTitle']);
    expect(view.brief).toContain('- September');
    expect(view.brief).toContain('- Macarena');
    expect(view.brief).not.toContain('COUNTS'); // a DJ gets music and the timeline, not the caterer's counts
  });
});
