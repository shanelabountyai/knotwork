import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capState, heldSeats, lockoutRegrets, planRelease, seatsNeeded, type HouseholdIn } from '@/lib/knotwork/guests/backfill';
import { chasePlan, CADENCE_DAYS, CALL_FROM_DAYS } from '@/lib/knotwork/guests/chase';
import { parseGuestCsv } from '@/lib/knotwork/guests/csv';
import { costCents, deltaFor, headcount, rollups, venueStatus } from '@/lib/knotwork/guests/headcount';
import { entitlement } from '@/lib/knotwork/guests/plus-one';
import { checkRsvp, FORBIDDEN_KEYS, reminderText, rsvpView, type RsvpViewInput } from '@/lib/knotwork/guests/projection';
import { readJson, ROOT } from './fixtures';

// Phase 2 pure engines (PRD P0-3, P0-4). Backfill and headcount expectations are recomputed by tools/guest_oracle.py.
type Backfill = { name: string; cap: number; list: 'A' | 'B'; lockoutDays: number; minBatchSeats: number; daysToWedding: number; households: HouseholdIn[]; expect: { entitled: Record<string, boolean>; held: Record<string, number>; needed: Record<string, number>; state: object; release: object; regrets: string[] } };
const backfill = readdirSync(join(ROOT, 'fixtures/guests/backfill')).sort().map((f) => readJson<Backfill>(`fixtures/guests/backfill/${f}`));

describe('backfill cap math (PRD P0-4: "released invites + accepted ≤ cap with pending-invite accounting")', () => {
  it('has the fixtures', () => expect(backfill.length).toBeGreaterThanOrEqual(12));

  it.each(backfill.map((f) => [f.name, f] as const))('%s', (_, f) => {
    expect(Object.fromEntries(f.households.map((h) => [h.id, entitlement(h).entitled]))).toEqual(f.expect.entitled);
    expect(Object.fromEntries(f.households.map((h) => [h.id, heldSeats(h)]))).toEqual(f.expect.held);
    expect(Object.fromEntries(f.households.map((h) => [h.id, seatsNeeded(h)]))).toEqual(f.expect.needed);
    expect(capState(f.households, f.cap)).toEqual(f.expect.state);
    const plan = planRelease(f.households, f);
    expect(plan).toEqual(f.expect.release);
    expect(lockoutRegrets(f.households, f)).toEqual(f.expect.regrets);
  });

  it('the overbooking fixture: pending invites hold their seats', () => {
    const f = backfill.find((x) => x.name === '03-pending-holds-its-seat')!;
    expect(capState(f.households, f.cap)).toMatchObject({ held: 4, available: 4 }); // 2 attending + 2 pending; the 2 declines are free
  });

  it('applying any release plan never passes the cap, and releasing again right after finds nothing new that breaks it', () => {
    for (const f of backfill) {
      const plan = planRelease(f.households, f);
      const after = f.households.map((h) => (plan.ids.includes(h.id) ? { ...h, state: 'invited' as const } : h));
      expect(capState(after, f.cap).held, f.name).toBeLessThanOrEqual(f.cap);
      const again = planRelease(after, f);
      const after2 = after.map((h) => (again.ids.includes(h.id) ? { ...h, state: 'invited' as const } : h));
      expect(capState(after2, f.cap).held, `${f.name} twice`).toBeLessThanOrEqual(f.cap);
    }
  });

  it('a release that was planned holds exactly the seats it said it would', () => {
    for (const f of backfill) {
      const plan = planRelease(f.households, f);
      const after = f.households.map((h) => (plan.ids.includes(h.id) ? { ...h, state: 'invited' as const } : h));
      expect(capState(after, f.cap).held - capState(f.households, f.cap).held, f.name).toBe(plan.seats);
    }
  });
});

describe('plus-one rules (PRD P0-3: engaged / married / long-distance / wedding party; overrides)', () => {
  type Case = { name: string; household: HouseholdIn; expect: { entitled: boolean; rule: string } };
  const { cases } = readJson<{ cases: Case[] }>('fixtures/guests/plus-one.json');
  it('covers every rule and both overrides', () => {
    expect([...new Set(cases.map((c) => c.expect.rule))].sort()).toEqual(['dating', 'engaged', 'long_distance', 'married', 'no-adult', 'override-deny', 'override-grant', 'partner-named', 'single', 'wedding-party']);
  });
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(entitlement(c.household)).toMatchObject(c.expect);
    expect(entitlement(c.household).reason.length).toBeGreaterThan(5); // every answer says why
  });
});

describe('headcount → cost (PRD P0-3: "per-head cost recalc on every response, delta feed")', () => {
  type Fx = { prices: { perHeadCents: number; kidsMealCents: number; vendorMealCents: number }; onSiteVendors: number; venueMin: number; venueMax: number; households: HouseholdIn[]; expect: object; expectRollups: object; expectVenue: string; decline: { guest: string; expect: object } };
  const fx = readJson<Fx>('fixtures/guests/headcount.json');
  const count = () => headcount(fx.households, fx.onSiteVendors);

  it('matches the hand math: 7 attending, 8 caterer meals, 80% responded, $498.00', () => {
    expect({ ...count(), costCents: costCents(count(), fx.prices) }).toEqual(fx.expect);
    expect(costCents(count(), fx.prices)).toBe(4 * 8700 + 2 * 3500 + 2 * 4000);
  });
  it('"Linda declined: −$87.00"', () => {
    const after = fx.households.map((h) => ({ ...h, guests: h.guests.map((g) => (g.name === fx.decline.guest ? { ...g, rsvp: 'declined' as const } : g)) }));
    expect(deltaFor('Linda', 'declined', count(), headcount(after, fx.onSiteVendors), fx.prices)).toMatchObject(fx.decline.expect);
    expect(deltaFor('Linda', 'declined', count(), headcount(after, fx.onSiteVendors), fx.prices).text).toBe('Linda declined: −$87.00');
    expect(deltaFor('Wren', 'accepted', headcount(after, fx.onSiteVendors), count(), fx.prices).text).toBe('Wren accepted: +$87.00');
  });
  it('a child costs a kids meal, an infant nothing, a vendor meal its own price', () => {
    const base = { attending: 0, adults: 0, kids: 0, infants: 0, vendorMeals: 0, catererMeals: 0, invited: 0, responded: 0, pending: 0, declined: 0, responseRatePct: 0 };
    expect(costCents({ ...base, kids: 1 }, fx.prices)).toBe(3500);
    expect(costCents({ ...base, infants: 3 }, fx.prices)).toBe(0);
    expect(costCents({ ...base, vendorMeals: 1 }, fx.prices)).toBe(4000);
  });
  it('venue minimum and maximum', () => {
    expect(venueStatus(7, fx.venueMin, fx.venueMax)).toBe(fx.expectVenue);
    expect(venueStatus(5, 6, 120)).toBe('below-min');
    expect(venueStatus(121, 6, 120)).toBe('over-max');
    expect(venueStatus(50, null, null)).toBe('unset');
  });
  it('rollups are counts, never names (PRD: data minimization)', () => {
    const r = rollups(fx.households);
    expect(r).toEqual(fx.expectRollups);
    const names = fx.households.flatMap((h) => [h.name, ...h.guests.map((g) => g.name)]);
    for (const n of names) expect(JSON.stringify(r)).not.toContain(n);
  });
  it('nobody invited is 0%, not a division by zero', () => {
    expect(headcount([], 0).responseRatePct).toBe(0);
  });
});

describe('RSVP chasing (PRD P0-3: reminder cadence, escalating to a call-personally worklist)', () => {
  type Case = { name: string; daysLeft: number; households: Parameters<typeof chasePlan>[0]; expect: ReturnType<typeof chasePlan> };
  const { cases } = readJson<{ cases: Case[] }>('fixtures/guests/chase.json');
  it('the cadence is data', () => {
    expect(CADENCE_DAYS).toEqual([21, 14, 7, 3]);
    expect(CALL_FROM_DAYS).toBe(3);
  });
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(chasePlan(c.households, c.daysLeft)).toEqual(c.expect);
  });
  it('running it twice on the same day sends nothing twice', () => {
    for (const c of cases) {
      const first = chasePlan(c.households, c.daysLeft);
      const after = c.households.map((h) => ({ ...h, remindersSent: [...h.remindersSent, ...first.remind.filter((r) => r.id === h.id).map((r) => r.step)] }));
      expect(chasePlan(after, c.daysLeft).remind, c.name).toEqual([]);
    }
  });
});

describe('guest CSV import (PRD P0-3: validated; rule 4: pasted text is hostile input)', () => {
  const good = readJson<{ csv: string; expect: { households: number; guests: number; first: object } }>('fixtures/guests/import-good.json');
  const bad = readJson<{ cases: { name: string; csv: string; errors: string[] }[] }>('fixtures/guests/import-bad.json');
  it('parses households and guests, quoted fields and all', () => {
    const r = parseGuestCsv(good.csv);
    expect(r.errors).toEqual([]);
    expect(r.households).toHaveLength(good.expect.households);
    expect(r.households.reduce((n, h) => n + h.guests.length, 0)).toBe(good.expect.guests);
    expect(r.households[0]).toMatchObject(good.expect.first);
  });
  it.each(bad.cases.map((c) => [c.name, c] as const))('refuses: %s', (_, c) => {
    const r = parseGuestCsv(c.csv);
    expect(r.errors.map((e) => e.message)).toEqual(c.errors);
    expect(r.households).toEqual([]); // all or nothing
  });
  it('caps size and rows', () => {
    expect(parseGuestCsv(`household,name\n${'x,y\n'.repeat(2001)}`).errors[0]!.message).toMatch(/at most 2000 rows/);
    expect(parseGuestCsv('a'.repeat(200_001)).errors[0]!.message).toMatch(/too large/);
  });
});

describe('rule 3: guest-facing surfaces never leak wave data (PRD P0-4, the undetectability invariant)', () => {
  const input = (list: 'A' | 'B', n: string): RsvpViewInput => ({
    wedding: { title: 'Juniper & Rowan', date: '2027-10-19' },
    rsvpBy: '2027-09-14',
    mealOptions: ['Chicken', 'Fish', 'Vegetarian'],
    household: { id: `h-${n}`, name: `The ${n} household`, list, state: 'invited', priority: list === 'A' ? 1 : 50, invitedOn: list === 'A' ? '2027-03-01' : '2027-07-20', waveNumber: list === 'A' ? 1 : 3, createdAt: '2026-11-24T00:00:00Z', plusOneAllowed: true },
    guests: [{ id: `g-${n}`, name: `${n} Guest`, ageGroup: 'adult', isPlusOne: false, rsvp: 'pending', meal: null, dietary: [], accessibility: [], songRequest: '', privateNote: 'seat far from the band' }],
  });
  const mask = (s: string) => s.replaceAll(/Alder|Birch/g, 'NAME').replaceAll(/[gh]-NAME/g, 'ID');

  it('an A-list and a B-list household get the same page, byte for byte, once names and ids are masked', () => {
    const [a, b] = [rsvpView(input('A', 'Alder')), rsvpView(input('B', 'Birch'))];
    expect(mask(JSON.stringify(b))).toBe(mask(JSON.stringify(a)));
  });
  it('the view has no wave, list, priority, invite date, creation time, state or private note, at any depth', () => {
    const walk = (o: unknown, keys: string[] = []): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => walk(v, [...keys, k])).concat(Object.keys(o)) : []);
    for (const list of ['A', 'B'] as const) {
      const v = rsvpView(input(list, 'Alder'));
      expect(walk(v).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
      const text = JSON.stringify(v);
      for (const leak of ['2027-03-01', '2027-07-20', '2026-11-24', 'seat far from the band', '"B"', 'wave', 'priority', 'invited']) expect(text, leak).not.toContain(leak);
    }
    expect(FORBIDDEN_KEYS).toEqual(expect.arrayContaining(['list', 'waveId', 'waveNumber', 'priority', 'invitedOn', 'createdAt', 'state', 'privateNote']));
  });
  it('the RSVP-by date is the same for everyone', () => {
    expect(rsvpView(input('A', 'Alder')).rsvpBy).toBe(rsvpView(input('B', 'Birch')).rsvpBy);
  });
  it('the reminder a household gets says nothing about its list either', () => {
    const text = (list: 'A' | 'B') => reminderText({ householdName: 'The NAME household', weddingTitle: 'Juniper & Rowan', rsvpBy: '2027-09-14', url: 'https://example.test/r/TOKEN', step: 14, list } as never);
    expect(text('B')).toEqual(text('A'));
    expect(JSON.stringify(text('B'))).not.toMatch(/wave|list|B-list|second/i);
  });
  it('accepts a sensible reply and refuses one that reaches outside the household or the menu', () => {
    const v = rsvpView(input('A', 'Alder'));
    const ok = checkRsvp(v, { responses: [{ guestId: 'g-Alder', attending: true, meal: 'Fish', dietary: ['vegan'], accessibility: [], songRequest: 'September' }], plusOneName: 'Robin Alder' });
    expect(ok).toMatchObject({ ok: true });
    expect(checkRsvp(v, { responses: [{ guestId: 'g-Birch', attending: true, meal: 'Fish', dietary: [], accessibility: [], songRequest: '' }], plusOneName: '' })).toEqual({ ok: false, message: 'That reply names someone who is not on this invitation.' });
    expect(checkRsvp(v, { responses: [{ guestId: 'g-Alder', attending: true, meal: 'Lobster', dietary: [], accessibility: [], songRequest: '' }], plusOneName: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/Pick a meal/) });
    expect(checkRsvp(v, { responses: [{ guestId: 'g-Alder', attending: true, meal: 'Fish', dietary: ['made-up'], accessibility: [], songRequest: '' }], plusOneName: '' })).toMatchObject({ ok: false });
    expect(checkRsvp(v, { responses: [], plusOneName: '' })).toMatchObject({ ok: false });
    const noPlus = rsvpView({ ...input('A', 'Alder'), household: { ...input('A', 'Alder').household, plusOneAllowed: false } });
    expect(checkRsvp(noPlus, { responses: [{ guestId: 'g-Alder', attending: true, meal: 'Fish', dietary: [], accessibility: [], songRequest: '' }], plusOneName: 'Robin' })).toEqual({ ok: false, message: 'This invitation does not include a guest.' });
    expect(checkRsvp(v, { responses: [{ guestId: 'g-Alder', attending: false, meal: '', dietary: [], accessibility: [], songRequest: '' }], plusOneName: 'Robin' })).toEqual({ ok: false, message: 'A guest can only come with someone who is attending.' });
  });
});
