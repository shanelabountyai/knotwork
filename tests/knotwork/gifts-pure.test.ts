import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allows, canSeeEntity, GRANT_SCOPES } from '@/lib/knotwork/access';
import { contributorsOf, GIFT_MAX_CENTS, GIFT_MIN_CENTS, netByHousehold, planClose, planContribution, potCents, replay, type Entry, type Replay, type Step } from '@/lib/knotwork/gifts/ledger';
import { GIFT_DONE, GIFT_PROBLEM, giftView, isGiftDone, isGiftProblem, type GiftViewInput } from '@/lib/knotwork/gifts/projection';
import { FORBIDDEN_KEYS } from '@/lib/knotwork/guests/projection';
import { regenerateGift, type GiftFx } from '../../scripts/knotwork/gen-fixtures';
import { ROOT } from './fixtures';

// Phase 3 pure engines for group gifting (PRD P0-5). The fixtures' expectations are recomputed by tools/gift_oracle.py.
type Fx = GiftFx & { expect: Replay };
const DIR = 'fixtures/gifts';
const files = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.json')).sort();
const fixtures = files.map((f) => ({ file: f, text: readFileSync(join(ROOT, DIR, f), 'utf8') })).map((x) => ({ ...x, fx: JSON.parse(x.text) as Fx }));
const fixture = (name: string) => fixtures.find((x) => x.fx.name === name)!.fx;
const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

describe('the gift ledger (PRD P0-5: partial contributions toward a target, fully-funded trigger, refund at close)', () => {
  it('has the fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    expect(fixtures.filter((x) => x.fx.race).length).toBeGreaterThanOrEqual(3);
  });

  it.each(fixtures.map((x) => [x.fx.name, x] as const))('%s', (_name, x) => {
    expect(replay(x.fx.targetCents, x.fx.steps)).toEqual(x.fx.expect);
    expect(regenerateGift(x.fx)).toBe(x.text); // the committed file is exactly what the ledger writes
    expect(`${x.fx.name}.json`).toBe(x.file);
  });

  it('every story keeps the invariants: integer cents, a pot from zero to its target, nobody below zero', () => {
    for (const { fx } of fixtures) {
      const r = replay(fx.targetCents, fx.steps);
      expect(r.entries.every((e) => Number.isInteger(e.amountCents) && e.amountCents !== 0), fx.name).toBe(true);
      expect(r.entries.every((e) => (e.kind === 'contribution') === e.amountCents > 0), fx.name).toBe(true);
      expect(r.potCents, fx.name).toBe(potCents(r.entries));
      expect(r.potCents >= 0 && r.potCents <= fx.targetCents, fx.name).toBe(true);
      expect(Object.values(r.net).every((n) => n >= 0), fx.name).toBe(true);
      expect(r.state === 'funded', fx.name).toBe(r.potCents === fx.targetCents);
      if (r.state === 'closed_unfunded') expect(r.potCents, fx.name).toBe(0);
      expect(r.thankYous, fx.name).toEqual(r.state === 'funded' ? contributorsOf(r.entries) : []);
    }
  });

  it('the race (PRD: "two givers completing the pot simultaneously"): in EVERY order the pot is exactly the target and the excess is returned or refused', () => {
    for (const { fx } of fixtures.filter((x) => x.fx.race)) {
      const offered = fx.steps.reduce((n, s) => n + (s.op === 'contribute' ? s.offerCents : 0), 0);
      expect(offered, fx.name).toBeGreaterThan(fx.targetCents);
      for (const order of permutations<Step>(fx.steps)) {
        const r = replay(fx.targetCents, order);
        expect([r.state, r.potCents], fx.name).toEqual(['funded', fx.targetCents]);
        const taken = r.entries.filter((e) => e.kind === 'contribution').reduce((n, e) => n + e.amountCents, 0);
        const back = r.entries.filter((e) => e.kind === 'excess_return').reduce((n, e) => n - e.amountCents, 0);
        expect(taken - back, fx.name).toBe(fx.targetCents);
        expect(Object.values(r.net).every((n) => n > 0), fx.name).toBe(true); // a refused offer left no entry at all
        expect(r.thankYous, fx.name).toEqual(Object.keys(r.net));
      }
    }
  });

  it('the race fixture by hand: 300.00 in a 500.00 pot, two offers of 250.00 at once', () => {
    const r = fixture('04-race-both-complete').expect;
    expect(r.steps[1]).toEqual({ ok: true, lines: [{ kind: 'contribution', amountCents: 25_000 }, { kind: 'excess_return', amountCents: -5_000 }], potCents: 50_000, state: 'funded' });
    expect(r.steps[2]).toEqual({ ok: false, code: 'funded' });
    expect(r.net).toEqual({ h1: 30_000, h2: 20_000 });
    expect(fixture('05-race-both-complete-other-order').expect.net).toEqual({ h1: 30_000, h3: 20_000 });
  });

  it('a contribution is one entry for the whole offer, plus one excess return when it is more than what remains', () => {
    const open = { targetCents: 50_000, state: 'open' as const };
    expect(planContribution(open, 0, 20_000)).toEqual({ ok: true, lines: [{ kind: 'contribution', amountCents: 20_000 }], keptCents: 20_000, returnedCents: 0, potAfterCents: 20_000, funds: false });
    expect(planContribution(open, 20_000, 30_000)).toMatchObject({ ok: true, returnedCents: 0, potAfterCents: 50_000, funds: true });
    expect(planContribution(open, 49_999, 100)).toEqual({ ok: true, lines: [{ kind: 'contribution', amountCents: 100 }, { kind: 'excess_return', amountCents: -99 }], keptCents: 1, returnedCents: 99, potAfterCents: 50_000, funds: true });
    expect(planContribution(open, 50_000, 100)).toEqual({ ok: false, code: 'funded' }); // nothing remains
    expect(planContribution({ ...open, state: 'funded' }, 50_000, 100)).toEqual({ ok: false, code: 'funded' });
    expect(planContribution({ ...open, state: 'closed_unfunded' }, 0, 100)).toEqual({ ok: false, code: 'closed' });
  });

  it('money is integer cents: a fraction of a cent, a float and anything outside 1.00 to 100,000.00 is refused', () => {
    const open = { targetCents: 50_000, state: 'open' as const };
    for (const bad of [0, -1, 99, 10.5, 0.1 + 0.2, Number.NaN, Number.POSITIVE_INFINITY, GIFT_MAX_CENTS + 1]) expect(planContribution(open, 0, bad), String(bad)).toEqual({ ok: false, code: 'amount' });
    expect(planContribution(open, 0, GIFT_MIN_CENTS)).toMatchObject({ ok: true });
    expect(planContribution(open, 0, GIFT_MAX_CENTS)).toMatchObject({ ok: true, keptCents: 50_000, returnedCents: GIFT_MAX_CENTS - 50_000 });
  });

  it('closing refunds each household exactly what it has in the pot, once, and leaves nobody below zero', () => {
    const entries: Entry[] = [
      { householdId: 'b', kind: 'contribution', amountCents: 15_000 },
      { householdId: 'a', kind: 'contribution', amountCents: 10_000 },
      { householdId: 'a', kind: 'contribution', amountCents: 5_000 },
    ];
    const refunds = planClose(entries);
    expect(refunds).toEqual([{ householdId: 'a', kind: 'refund', amountCents: -15_000 }, { householdId: 'b', kind: 'refund', amountCents: -15_000 }]);
    expect([...netByHousehold([...entries, ...refunds]).values()]).toEqual([0, 0]);
    expect(planClose([...entries, ...refunds])).toEqual([]); // closing twice refunds nothing twice
    expect(planClose([])).toEqual([]);
  });
});

describe('rule 3 and P0-5 privacy: what a household sees of the registry', () => {
  const input = (list: 'A' | 'B', n: string, own: GiftViewInput['own'] = [], ownClaims: GiftViewInput['ownClaims'] = []): GiftViewInput => ({
    wedding: { title: 'Juniper & Rowan' },
    household: { id: `h-${n}`, name: `The ${n} household`, list, state: 'invited', priority: list === 'A' ? 1 : 50, invitedOn: list === 'A' ? '2027-03-01' : '2027-07-20', waveNumber: list === 'A' ? 1 : 3, createdAt: '2026-11-24T00:00:00Z' },
    items: [
      { id: 'i-1', title: 'Canoe trip', note: 'Two days on the Buffalo River', targetCents: 50_000, potCents: 35_801, state: 'open', createdById: 'u-1', createdAt: '2026-11-25T00:00:00Z', contributors: ['The Other household'], entries: [{ householdId: 'h-Other', amountCents: 23_456 }] },
      { id: 'i-2', title: 'Record player', note: '', targetCents: 20_000, potCents: 20_000, state: 'funded', fundedOn: '2027-01-05' },
      { id: 'i-3', title: 'Tent', note: '', targetCents: 30_000, potCents: 0, state: 'closed_unfunded', closedOn: '2027-02-01' },
    ],
    own,
    // P1-8: store items. The internal fields (who else claimed, when the row was made) must have no way out.
    links: [
      { id: 'l-1', title: 'Cast-iron skillet', store: 'Example Kitchen Co.', url: 'https://www.example.com/skillet', priceCents: 4_500, quantityWanted: 2, claimed: 1, claimants: ['The Other household'], createdAt: '2026-11-25T00:00:00Z' },
      { id: 'l-2', title: 'Linen napkins', store: 'Example Linens', url: 'javascript:alert(1)', priceCents: null, quantityWanted: 1, claimed: 1 },
    ],
    ownClaims,
  });
  const claimedOne: GiftViewInput['ownClaims'] = [{ linkId: 'l-1', quantity: 1, on: '2027-04-03', id: 'c-1', householdId: 'h-x', createdAt: '2027-04-03T10:00:00Z' }];
  const mine: GiftViewInput['own'] = [{ itemId: 'i-1', kind: 'contribution', amountCents: 12_345, on: '2027-04-02', id: 'e-1', householdId: 'h-x', createdAt: '2027-04-02T10:00:00Z' }];
  const mask = (s: string) => s.replaceAll(/Alder|Birch/g, 'NAME');
  const walk = (o: unknown): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...walk(v)]) : []);

  it('an A-list and a B-list household get the same page, byte for byte, once the name is masked', () => {
    expect(mask(JSON.stringify(giftView(input('B', 'Birch'))))).toBe(mask(JSON.stringify(giftView(input('A', 'Alder')))));
    expect(mask(JSON.stringify(giftView(input('B', 'Birch', mine))))).toBe(mask(JSON.stringify(giftView(input('A', 'Alder', mine)))));
    expect(mask(JSON.stringify(giftView(input('B', 'Birch', mine, claimedOne))))).toBe(mask(JSON.stringify(giftView(input('A', 'Alder', mine, claimedOne)))));
  });

  it('the view has no wave, list, priority, invite date, creation time or state, at any depth', () => {
    for (const list of ['A', 'B'] as const) {
      const v = giftView(input(list, 'Alder', mine, claimedOne));
      expect(walk(v).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
      const text = JSON.stringify(v);
      for (const leak of ['2027-03-01', '2027-07-20', '2026-11-24', '2026-11-25', '"B"', 'wave', 'priority', 'invited', 'h-Alder', 'u-1', 'createdAt', 'householdId']) expect(text, leak).not.toContain(leak);
    }
  });

  it('a household sees each gift\'s progress and its own entries; nothing of anyone else\'s has a way in', () => {
    const v = giftView(input('A', 'Alder', mine));
    const text = JSON.stringify(v);
    for (const leak of ['The Other household', 'h-Other', '23456', '234.56', 'contributors', 'entries']) expect(text, leak).not.toContain(leak);
    expect(v.items[0]).toEqual({
      id: 'i-1', title: 'Canoe trip', note: 'Two days on the Buffalo River', status: 'open', targetText: '$500.00', raisedText: '$358.01', remainingText: '$141.99', percent: 71,
      yoursText: '$123.45', yours: [{ text: 'You gave', amountText: '$123.45', onText: 'Fri, Apr 2, 2027' }],
    });
    expect(v.items.map((i) => [i.status, i.yoursText])).toEqual([['open', '$123.45'], ['funded', null], ['closed', null]]);
    expect(v.anyOpen).toBe(true);
    // A household that gave nothing sees the same progress and no contributions.
    expect(giftView(input('A', 'Alder')).items[0]).toMatchObject({ raisedText: '$358.01', yoursText: null, yours: [] });
  });

  it('P1-8: a store item shows how many are still wanted and the household\'s own claim; never who else claimed; a bad stored address is no link', () => {
    const v = giftView(input('A', 'Alder', [], claimedOne));
    expect(v.links).toEqual([
      { id: 'l-1', title: 'Cast-iron skillet', store: 'Example Kitchen Co.', href: 'https://www.example.com/skillet', host: 'www.example.com', priceText: '$45.00', wanted: 2, remaining: 1, yours: { quantity: 1, onText: 'Sat, Apr 3, 2027' } },
      { id: 'l-2', title: 'Linen napkins', store: 'Example Linens', href: null, host: null, priceText: null, wanted: 1, remaining: 0, yours: null },
    ]);
    const text = JSON.stringify(giftView(input('A', 'Alder', [], claimedOne)));
    for (const leak of ['The Other household', 'claimants', 'javascript', 'c-1', 'createdAt']) expect(text, leak).not.toContain(leak);
    expect(giftView(input('A', 'Alder')).links[0]!.yours).toBeNull();
  });

  it('an excess return and a refund read as money coming back, and the total is what is still in the pot', () => {
    const v = giftView(input('A', 'Alder', [
      { itemId: 'i-2', kind: 'contribution', amountCents: 25_000, on: '2027-01-05' },
      { itemId: 'i-2', kind: 'excess_return', amountCents: -5_000, on: '2027-01-05' },
      { itemId: 'i-3', kind: 'contribution', amountCents: 4_000, on: '2027-01-10' },
      { itemId: 'i-3', kind: 'refund', amountCents: -4_000, on: '2027-02-01' },
    ]));
    expect(v.items[1]!.yours.map((l) => `${l.text}: ${l.amountText}`)).toEqual(['You gave: $250.00', 'Returned to you (more than was still needed): $50.00']);
    expect(v.items[1]!.yoursText).toBe('$200.00');
    expect(v.items[2]!.yours[1]).toMatchObject({ text: 'Refunded to you (the gift was closed before it was funded)', amountText: '$40.00' });
    expect(v.items[2]!.yoursText).toBe('$0.00');
  });

  it('what a guest is told is a closed list of fixed sentences; a code that is not on it shows nothing', () => {
    expect(Object.keys(GIFT_PROBLEM).sort()).toEqual(['already', 'amount', 'closed', 'fail', 'funded', 'not-claimed', 'not-here', 'quantity', 'taken', 'too-many']);
    expect(Object.keys(GIFT_DONE).sort()).toEqual(['claimed', 'part', 'thanks', 'withdrawn']);
    for (const bad of ['', 'constructor', '__proto__', 'toString', '<script>', 'Amount']) expect(isGiftProblem(bad) || isGiftDone(bad), bad).toBe(false);
    // Fixed text: the only figures are the two bounds every household is shown.
    expect(Object.values({ ...GIFT_PROBLEM, ...GIFT_DONE }).join(' ').match(/\$[\d,.]+\d/g)).toEqual(['$1.00', '$100,000.00']);
  });
});

describe('gifting is the partners\' alone (PRD P0-5 privacy; P0-2 scoped grants)', () => {
  it('no helper grant reaches the registry or its entries in the feed', () => {
    const everything = { role: 'member', grants: [...GRANT_SCOPES] };
    for (const cap of ['gifts.view', 'gifts.edit'] as const) {
      expect(allows(everything, cap), cap).toBe(false);
      expect(allows({ role: 'admin', grants: [...GRANT_SCOPES] }, cap), cap).toBe(false);
      expect(allows({ role: 'owner', grants: [] }, cap), cap).toBe(true);
    }
    for (const entity of ['registry', 'gift', 'thankyou', 'giftlog', 'registrylink', 'claim']) {
      expect(canSeeEntity(everything, entity), entity).toBe(false);
      expect(canSeeEntity({ role: 'owner', grants: [] }, entity), entity).toBe(true);
    }
  });
});
